import * as THREE from 'three'

/**
 * A god's-eye camera: orbit a focus point on the ground, smooth and bounded. Left-drag orbits, right-drag (or
 * Shift/Ctrl-drag) pans, the wheel zooms toward the cursor, WASD pans, Q/E turn. A short click (no drag) is reported
 * to the game as a tap on the ground. Shake and scripted flights layer on top.
 */

export interface Pose { x: number; z: number; distance: number; yaw: number; pitch: number }

const clamp = THREE.MathUtils.clamp
const damp = (a: number, b: number, lambda: number, dt: number) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt))

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera
  readonly focus = new THREE.Vector3()
  // desired and current
  goal: Pose = { x: 0, z: 0, distance: 2200, yaw: 0.6, pitch: 0.62 }
  cur: Pose = { ...this.goal }
  bounds = { minX: -3000, maxX: 3000, minZ: -2400, maxZ: 2400 }
  minDistance = 90
  maxDistance = 7500
  enabled = true
  /** extra height (m) to look at above the focus: tilts the camera up for cinematic framing */
  aim = 0
  onTap: ((ndc: THREE.Vector2, event: PointerEvent) => void) | null = null
  onHover: ((ndc: THREE.Vector2 | null) => void) | null = null
  private trauma = 0
  private shakeTime = 0
  private flight: { from: Pose; to: Pose; t: number; dur: number } | null = null
  private keys = new Set<string>()
  private drag: { id: number; x: number; y: number; button: number; moved: boolean; mode: 'orbit' | 'pan' } | null = null
  private touches = new Map<number, { x: number; y: number }>()
  private pinch: { d: number; cx: number; cy: number } | null = null
  private ray = new THREE.Raycaster()
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private tmp = new THREE.Vector3()

  constructor(private dom: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(38, 1, 2, 120000)
    dom.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove)
    window.addEventListener('pointerup', this.onUp)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    dom.addEventListener('contextmenu', e => e.preventDefault())
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', () => this.keys.clear())
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    this.dom.removeEventListener('wheel', this.onWheel)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKeyUp)
  }

  set(pose: Partial<Pose>, instant = false) {
    Object.assign(this.goal, pose)
    this.clampGoal()
    if (instant) {
      Object.assign(this.cur, this.goal)
      this.flight = null
    }
  }

  flyTo(pose: Partial<Pose>, duration = 2.2) {
    const to = { ...this.goal, ...pose }
    this.flight = { from: { ...this.cur }, to, t: 0, dur: duration }
  }

  shake(amount: number) { this.trauma = Math.min(1.2, this.trauma + amount) }

  /** Ground point under a normalized device coordinate. */
  ground(ndc: THREE.Vector2, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.ray.setFromCamera(ndc, this.camera)
    return this.ray.ray.intersectPlane(this.plane, out)
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect()
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return
    this.flight = null
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()]
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
        this.drag = null
        return
      }
    }
    const pan = e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, moved: false, mode: pan ? 'pan' : 'orbit' }
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId)!
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.pinch && this.touches.size === 2) {
        const [a, b] = [...this.touches.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
        this.goal.distance *= this.pinch.d / Math.max(d, 1)
        this.panBy(cx - this.pinch.cx, cy - this.pinch.cy)
        this.pinch = { d, cx, cy }
        this.clampGoal()
        return
      }
      void prev
    }
    if (!this.drag || e.pointerId !== this.drag.id) {
      if (e.target === this.dom && !this.drag) this.onHover?.(this.ndc(e))
      return
    }
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
    if (!this.drag.moved && Math.hypot(dx, dy) < 5) return
    this.drag.moved = true
    this.drag.x = e.clientX
    this.drag.y = e.clientY
    if (this.drag.mode === 'orbit') {
      this.goal.yaw -= dx * 0.0042
      this.goal.pitch += dy * 0.0032
    } else this.panBy(dx, dy)
    this.clampGoal()
  }

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId)
    if (this.touches.size < 2) this.pinch = null
    const d = this.drag
    if (!d || e.pointerId !== d.id) return
    this.drag = null
    if (!d.moved && d.button === 0 && e.target === this.dom) this.onTap?.(this.ndc(e), e)
  }

  private panBy(dx: number, dy: number) {
    const s = this.cur.distance * 0.00135
    const c = Math.cos(this.goal.yaw), sn = Math.sin(this.goal.yaw)
    // screen right is (cos, -sin) in xz for yaw measured around y
    this.goal.x -= (dx * c + dy * sn) * s
    this.goal.z -= (-dx * sn + dy * c) * s
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return
    e.preventDefault()
    this.flight = null
    const factor = Math.exp(clamp(e.deltaY, -120, 120) * 0.0016)
    const before = this.ground(this.ndc(e), new THREE.Vector3())
    const old = this.goal.distance
    this.goal.distance = clamp(old * factor, this.minDistance, this.maxDistance)
    // zoom toward the cursor
    if (before && factor < 1) {
      const k = 1 - this.goal.distance / old
      this.goal.x += (before.x - this.goal.x) * k
      this.goal.z += (before.z - this.goal.z) * k
    }
    this.clampGoal()
  }

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
    this.keys.add(e.key.toLowerCase())
  }
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()) }

  private clampGoal() {
    const g = this.goal
    g.distance = clamp(g.distance, this.minDistance, this.maxDistance)
    g.pitch = clamp(g.pitch, 0.18, 1.45)
    g.x = clamp(g.x, this.bounds.minX, this.bounds.maxX)
    g.z = clamp(g.z, this.bounds.minZ, this.bounds.maxZ)
  }

  update(dt: number) {
    if (this.enabled && this.keys.size) {
      const speed = this.cur.distance * 0.9 * dt * (this.keys.has('shift') ? 2.6 : 1)
      const c = Math.cos(this.goal.yaw), s = Math.sin(this.goal.yaw)
      let fx = 0, fz = 0
      if (this.keys.has('w') || this.keys.has('arrowup')) fz -= 1
      if (this.keys.has('s') || this.keys.has('arrowdown')) fz += 1
      if (this.keys.has('a') || this.keys.has('arrowleft')) fx -= 1
      if (this.keys.has('d') || this.keys.has('arrowright')) fx += 1
      this.goal.x += (fx * c + fz * s) * speed
      this.goal.z += (-fx * s + fz * c) * speed
      if (this.keys.has('q')) this.goal.yaw += dt * 1.1
      if (this.keys.has('e')) this.goal.yaw -= dt * 1.1
      if (fx || fz) this.flight = null
      this.clampGoal()
    }
    if (this.flight) {
      const f = this.flight
      f.t += dt / f.dur
      const k = f.t >= 1 ? 1 : f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2
      // arc out a little on long flights so the city stays in view
      const lift = Math.sin(Math.PI * Math.min(1, f.t)) * Math.min(1, Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z) / 2500) * 0.35
      this.cur.x = THREE.MathUtils.lerp(f.from.x, f.to.x, k)
      this.cur.z = THREE.MathUtils.lerp(f.from.z, f.to.z, k)
      this.cur.distance = THREE.MathUtils.lerp(f.from.distance, f.to.distance, k) * (1 + lift)
      this.cur.yaw = THREE.MathUtils.lerp(f.from.yaw, f.to.yaw, k)
      this.cur.pitch = THREE.MathUtils.lerp(f.from.pitch, f.to.pitch, k)
      if (f.t >= 1) {
        Object.assign(this.goal, f.to)
        this.flight = null
      }
    } else {
      const c = this.cur, g = this.goal
      c.x = damp(c.x, g.x, 9, dt)
      c.z = damp(c.z, g.z, 9, dt)
      c.distance = damp(c.distance, g.distance, 8, dt)
      c.yaw = damp(c.yaw, g.yaw, 10, dt)
      c.pitch = damp(c.pitch, g.pitch, 10, dt)
    }
    const c = this.cur
    this.focus.set(c.x, 0, c.z)
    const cp = Math.cos(c.pitch)
    const pos = this.tmp.set(c.x + Math.sin(c.yaw) * cp * c.distance, Math.sin(c.pitch) * c.distance, c.z + Math.cos(c.yaw) * cp * c.distance)
    this.camera.position.copy(pos)
    this.camera.lookAt(this.focus.x, Math.max(Math.min(c.distance * 0.04, 60), this.aim), this.focus.z)
    // shake: trauma squared, scaled to how far away we are
    this.shakeTime += dt
    if (this.trauma > 0.001) {
      const t = this.trauma * this.trauma
      const amp = t * Math.min(c.distance, 2500) * 0.012
      const n = (f: number, o: number) => Math.sin(this.shakeTime * f + o) * 0.6 + Math.sin(this.shakeTime * f * 2.37 + o * 1.7) * 0.4
      this.camera.position.x += n(23, 0.3) * amp
      this.camera.position.y += n(27, 1.9) * amp * 0.7
      this.camera.position.z += n(19, 4.1) * amp
      this.camera.rotateZ(n(17, 2.2) * t * 0.012)
      this.trauma = Math.max(0, this.trauma - dt * 0.55)
    }
    this.camera.near = clamp(c.distance * 0.01, 1, 40)
    this.camera.updateProjectionMatrix()
  }
}
