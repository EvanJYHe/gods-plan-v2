import * as THREE from 'three'
import { CITIES, type City } from './cities'
import { markBusy } from './idle'

/**
 * The destination globe: NASA's Blue Marble pushed to a saturated, airy blue, a soft white halo, and a pin per city. Drag to spin (with inertia); it drifts on its own until touched. `focus(city)` turns a city to
 * face us; `enter(city)` does that and dives at it.
 *
 * Performance: the loop renders only while visible (`paused`), labels are moved by writing transforms straight onto
 * their elements (no React state per frame), and hover hits are a ray–sphere test rather than a mesh raycast.
 */

export type { City }

const toVec = (lat: number, lon: number, r = 1) => {
  const phi = THREE.MathUtils.degToRad(90 - lat)
  const theta = THREE.MathUtils.degToRad(lon + 180)
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta))
}
const yawFor = (c: City) => -THREE.MathUtils.degToRad(c.lon + 90)
const pitchFor = (c: City) => THREE.MathUtils.clamp(THREE.MathUtils.degToRad(c.lat), -1.1, 1.1)

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`
const earthFragment = /* glsl */ `
  uniform sampler2D uDay;
  uniform vec3 uSun;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    vec3 tex = texture2D(uDay, vUv).rgb;
    float l = dot(tex, vec3(0.3, 0.59, 0.11));
    // Blue Marble's sea is dark and blue-dominant; forests are dark but green, ice is bright
    float ocean = smoothstep(1.12, 1.45, tex.b / max(max(tex.r, tex.g), 0.002)) * (1.0 - smoothstep(0.3, 0.5, l));
    // land: saturated and a touch warmer; ocean: a vivid cobalt, brighter in the shallows
    vec3 land = mix(vec3(l), tex, 1.45) * 1.25;
    vec3 sea = mix(vec3(0.02, 0.2, 0.78), vec3(0.08, 0.42, 1.0), smoothstep(0.0, 0.25, tex.b));
    vec3 col = mix(land, sea, ocean);
    float sun = dot(n, uSun);
    col *= 0.62 + 0.55 * max(sun, 0.0);
    vec3 h = normalize(uSun + v);
    col += vec3(1.0) * pow(max(dot(n, h), 0.0), 400.0) * ocean * 0.18;
    float rim = pow(1.0 - max(dot(n, v), 0.0), 2.6);
    col = mix(col, vec3(0.86, 0.95, 1.0), rim * 0.75);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`
const haloFragment = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(cameraPosition - vWorld);
    // seen from outside, the back faces run from |n.v| = 0 at the halo's edge to ~0.33 at the earth's limb
    float k = clamp(abs(dot(n, v)) / 0.33, 0.0, 1.0);
    gl_FragColor = vec4(vec3(0.94, 0.98, 1.0), pow(k, 2.2) * 0.85);
    #include <colorspace_fragment>
  }`

export class Globe {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100)
  readonly earth: THREE.Group
  /** while true the loop keeps ticking but skips rendering (the layer is hidden) */
  paused = false
  onHover: ((city: City | null) => void) | null = null
  onPick: ((city: City) => void) | null = null
  /** called after each rendered frame, e.g. for the HUD */
  onFrame: (() => void) | null = null
  private markers: { city: City; dot: THREE.Mesh; ring: THREE.Mesh | null; pos: THREE.Vector3; label: HTMLElement | null }[] = []
  private raf = 0
  private yaw = THREE.MathUtils.degToRad(-60)
  private pitch = 0.5
  private vYaw = 0
  private touched = false
  private drag: { x: number; y: number; moved: boolean } | null = null
  private aim: { yaw: number; pitch: number } | null = null
  private dive: { t0: number; dur: number; from: { yaw: number; pitch: number; dist: number }; to: { yaw: number; pitch: number }; fired: boolean; onNear: () => void } | null = null
  private dist = 4.1
  private last = performance.now()
  private hovered: City | null = null
  private disposed = false
  private rect = { left: 0, top: 0, width: 1, height: 1 }
  private tmp = new THREE.Vector3()
  private camDir = new THREE.Vector3()
  /** screen centre and radius of the disc, in CSS px */
  disc = { x: 0, y: 0, r: 0 }

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(0x000000, 0)
    host.appendChild(this.renderer.domElement)
    // decode the 4K texture off the main thread
    const tex = new THREE.Texture()
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    tex.flipY = false
    new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY' }).load('/globe/earth-day.jpg', bmp => {
      tex.image = bmp
      tex.needsUpdate = true
    })
    const sun = new THREE.Vector3(-0.55, 0.45, 0.75).normalize()
    this.earth = new THREE.Group()
    const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({ vertexShader: earthVertex, fragmentShader: earthFragment, uniforms: { uDay: { value: tex }, uSun: { value: sun } } }))
    this.earth.add(ball)
    const halo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 64, 32), new THREE.ShaderMaterial({ vertexShader: earthVertex, fragmentShader: haloFragment, transparent: true, side: THREE.BackSide, depthWrite: false }))
    this.scene.add(this.earth, halo)
    for (const city of CITIES) {
      const pos = toVec(city.lat, city.lon, 1.002)
      const dot = new THREE.Mesh(new THREE.CircleGeometry(city.live ? 0.012 : 0.008, 24), new THREE.MeshBasicMaterial({ color: city.live ? 0x1c38ea : 0xffffff, depthWrite: false, transparent: true, opacity: city.live ? 1 : 0.9 }))
      const ring = city.live ? new THREE.Mesh(new THREE.RingGeometry(0.018, 0.022, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false })) : null
      for (const m of ring ? [dot, ring] : [dot]) {
        m.position.copy(pos)
        m.lookAt(pos.clone().multiplyScalar(2))
        this.earth.add(m)
      }
      this.markers.push({ city, dot, ring, pos, label: null })
    }
    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.down)
    el.addEventListener('pointerleave', this.leave)
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    window.addEventListener('resize', this.resize)
    this.resize()
    this.loop()
  }

  /** Labels are DOM elements owned by React; the globe only moves them. */
  bindLabel(id: string, el: HTMLElement | null) {
    const m = this.markers.find(m => m.city.id === id)
    if (m) m.label = el
  }

  /** Turn a city to face us (eased); a drag cancels it. */
  focus(city: City | null) {
    if (this.dive || !city) return
    let to = yawFor(city)
    while (to - this.yaw > Math.PI) to -= Math.PI * 2
    while (to - this.yaw < -Math.PI) to += Math.PI * 2
    this.aim = { yaw: to, pitch: pitchFor(city) * 0.8 }
    this.touched = true
    this.vYaw = 0
  }

  private resize = () => {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))
    // centred and large: the disc fills ~64% of the height, or ~88% of the width on tall screens, a little below the
    // middle to leave room for the title
    const byHeight = Math.hypot(1 / (0.64 * t), 1)
    const byWidth = Math.hypot(h / (0.88 * w * t), 1)
    this.dist = Math.max(byHeight, byWidth)
    this.camera.setViewOffset(w, h, 0, byWidth > byHeight ? 0 : -h * 0.045, w, h)
    this.camera.updateProjectionMatrix()
    this.camera.position.set(0, 0, this.dist)
    this.camera.lookAt(0, 0, 0)
    this.camera.updateMatrixWorld()
    const r = this.renderer.domElement.getBoundingClientRect()
    this.rect = { left: r.left, top: r.top, width: r.width, height: r.height }
    const c = this.screen(this.tmp.set(0, 0, 0))
    this.disc = { x: c.x, y: c.y, r: (1 / Math.sqrt(this.dist * this.dist - 1)) / t * (h / 2) }
  }

  private screen(world: THREE.Vector3) {
    const p = world.project(this.camera)
    return { x: (p.x * 0.5 + 0.5) * this.rect.width, y: (-p.y * 0.5 + 0.5) * this.rect.height }
  }

  /** Ray–sphere hit in the earth's local frame, then the nearest pin. */
  private cityAt(e: { clientX: number; clientY: number }): City | null {
    const nx = ((e.clientX - this.rect.left) / this.rect.width) * 2 - 1
    const ny = -((e.clientY - this.rect.top) / this.rect.height) * 2 + 1
    const o = this.camera.position
    const d = this.tmp.set(nx, ny, 0.5).unproject(this.camera).sub(o).normalize()
    const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c
    if (disc < 0) return null
    const hit = o.clone().addScaledVector(d, -b - Math.sqrt(disc))
    const local = this.earth.worldToLocal(hit)
    let best: City | null = null, bd = 0.07
    for (const m of this.markers) {
      const dd = m.pos.distanceTo(local)
      if (dd < bd) { bd = dd; best = m.city }
    }
    return best
  }

  private setHover(c: City | null) {
    if (c === this.hovered) return
    this.hovered = c
    this.renderer.domElement.style.cursor = c ? 'pointer' : 'grab'
    this.onHover?.(c)
  }

  private down = (e: PointerEvent) => {
    if (this.dive) return
    markBusy()
    this.drag = { x: e.clientX, y: e.clientY, moved: false }
    this.touched = true
    this.aim = null
  }
  private move = (e: PointerEvent) => {
    if (this.drag) {
      markBusy()
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y
      if (Math.hypot(dx, dy) > 4) this.drag.moved = true
      this.drag.x = e.clientX
      this.drag.y = e.clientY
      this.vYaw = dx * 0.005
      this.yaw += dx * 0.005
      this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, -1.1, 1.1)
      return
    }
    if (e.target !== this.renderer.domElement || this.dive) return
    markBusy()
    this.setHover(this.cityAt(e))
  }
  private leave = () => { if (!this.drag) this.setHover(null) }
  private up = (e: PointerEvent) => {
    const d = this.drag
    this.drag = null
    if (d && !d.moved && e.target === this.renderer.domElement) {
      const c = this.cityAt(e)
      if (c) this.onPick?.(c)
    }
  }

  /** Spin the city to face us, then dive at it. `onNear` fires near the surface so the city can take over. */
  enter(city: City, onNear: () => void) {
    let to = yawFor(city)
    while (to - this.yaw > Math.PI) to -= Math.PI * 2
    while (to - this.yaw < -Math.PI) to += Math.PI * 2
    this.aim = null
    this.setHover(null)
    this.dive = { t0: performance.now(), dur: 2600, from: { yaw: this.yaw, pitch: this.pitch, dist: this.dist }, to: { yaw: to, pitch: THREE.MathUtils.degToRad(city.lat) }, fired: false, onNear }
  }

  /** Back from the city: reset the camera to the overview. */
  reset() {
    this.dive = null
    this.resize()
  }

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (this.paused) return
    let dist = this.dist
    if (this.dive) {
      const k = Math.min(1, (now - this.dive.t0) / this.dive.dur)
      const turn = 1 - Math.pow(1 - Math.min(1, k / 0.5), 3)
      this.yaw = THREE.MathUtils.lerp(this.dive.from.yaw, this.dive.to.yaw, turn)
      this.pitch = THREE.MathUtils.lerp(this.dive.from.pitch, this.dive.to.pitch, turn)
      const z = Math.pow(Math.max(0, (k - 0.22) / 0.78), 2.2)
      dist = THREE.MathUtils.lerp(this.dive.from.dist, 1.02, z)
      if (k > 0.74 && !this.dive.fired) { this.dive.fired = true; this.dive.onNear() }
    } else if (this.aim) {
      const a = 1 - Math.exp(-dt * 4.5)
      this.yaw += (this.aim.yaw - this.yaw) * a
      this.pitch += (this.aim.pitch - this.pitch) * a
    } else if (!this.drag) {
      this.vYaw *= Math.exp(-dt * 2.5)
      this.yaw += this.vYaw + (this.touched ? dt * 0.012 : dt * 0.05)
    }
    this.earth.rotation.set(0, 0, 0)
    this.earth.rotateX(this.pitch)
    this.earth.rotateY(this.yaw)
    this.camera.position.set(0, 0, dist)
    this.camera.lookAt(0, 0, 0)
    this.earth.updateMatrixWorld()
    const pulse = (now / 1000) % 1.6 / 1.6
    this.camDir.copy(this.camera.position).normalize()
    for (const m of this.markers) {
      if (m.ring) {
        m.ring.scale.setScalar(1 + pulse * 2.2)
        ;(m.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - pulse)
      }
      if (!m.label) continue
      const w = this.tmp.copy(m.pos).applyMatrix4(this.earth.matrixWorld)
      const facing = w.clone().normalize().dot(this.camDir)
      const p = this.screen(w)
      const vis = this.dive ? 0 : THREE.MathUtils.smoothstep(facing, 0.22, 0.45)
      m.label.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`
      m.label.style.opacity = vis.toFixed(3)
      m.label.style.visibility = vis < 0.02 ? 'hidden' : 'visible'
    }
    this.renderer.render(this.scene, this.camera)
    this.onFrame?.()
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('resize', this.resize)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
