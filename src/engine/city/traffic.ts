import * as THREE from 'three'
import type { CityData } from '../data'
import type { Engine } from '../engine'

/** Cars driving the major roads (instanced), with headlights at night. Cars caught in a disaster are thrown or swept. */

interface Road { pts: Float32Array; cum: Float32Array; len: number; speed: number; w: number }
interface Car { road: number; s: number; dir: 1 | -1; speed: number; lane: number; alive: boolean; hue: number }

const COLOURS = [0xf2f2f0, 0x1e1f22, 0x8b8f94, 0xb9bdc2, 0x2a3f5f, 0x7a1f1f, 0x355e3b, 0xd8d2c4, 0x3c3c3c, 0xc9a227]

export class Traffic {
  private roads: Road[] = []
  private cars: Car[] = []
  readonly body: THREE.InstancedMesh
  readonly lights: THREE.InstancedMesh
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private v = new THREE.Vector3()
  private s = new THREE.Vector3(1, 1, 1)
  private night = 0

  constructor(data: CityData, scene: THREE.Scene) {
    for (const [w, speed, line] of data.roads) {
      const n = line.length / 2
      const pts = new Float32Array(n * 2)
      const cum = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        pts[i * 2] = line[i * 2] / 10
        pts[i * 2 + 1] = -line[i * 2 + 1] / 10
        if (i) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1])
      }
      if (cum[n - 1] > 40) this.roads.push({ pts, cum, len: cum[n - 1], speed: Math.max(speed / 10, 8), w: w / 10 })
    }
    const total = this.roads.reduce((a, r) => a + r.len, 0)
    const count = Math.min(1400, Math.round(total / 55))
    for (let i = 0; i < count; i++) {
      // pick roads weighted by length
      let x = Math.random() * total, ri = 0
      while (x > this.roads[ri].len && ri < this.roads.length - 1) x -= this.roads[ri++].len
      const dir = Math.random() < 0.5 ? 1 : -1
      this.cars.push({ road: ri, s: x, dir, speed: this.roads[ri].speed * (0.55 + Math.random() * 0.35), lane: 1.8 + Math.random() * 1.4, alive: true, hue: Math.floor(Math.random() * COLOURS.length) })
    }
    const geo = new THREE.BoxGeometry(4.4, 1.5, 1.9)
    geo.translate(0, 0.75, 0)
    this.body = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.4 }), this.cars.length)
    this.cars.forEach((c, i) => this.body.setColorAt(i, new THREE.Color(COLOURS[c.hue])))
    this.body.castShadow = false
    this.body.receiveShadow = true
    this.body.frustumCulled = false
    const lg = new THREE.PlaneGeometry(1, 1)
    lg.rotateX(-Math.PI / 2)
    this.lights = new THREE.InstancedMesh(lg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }), this.cars.length * 2)
    this.lights.frustumCulled = false
    this.lights.visible = false
    const warm = new THREE.Color(3, 2.6, 1.9), red = new THREE.Color(2.4, 0.2, 0.15)
    for (let i = 0; i < this.cars.length; i++) {
      this.lights.setColorAt(i * 2, warm)
      this.lights.setColorAt(i * 2 + 1, red)
    }
    scene.add(this.body, this.lights)
  }

  setNight(n: number) {
    this.night = n
    this.lights.visible = n > 0.2
  }

  /** Remove cars inside a circle (thrown as debris by the caller). */
  inCircle(x: number, z: number, r: number, cb: (px: number, pz: number) => void) {
    const p = new THREE.Vector3()
    this.cars.forEach(c => {
      if (!c.alive) return
      this.position(c, p)
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) { c.alive = false; cb(p.x, p.z) }
    })
  }

  /** Remove cars behind a line (swept by water). */
  behind(ox: number, oz: number, dx: number, dz: number, front: number, cb: (px: number, pz: number) => void) {
    const p = new THREE.Vector3()
    this.cars.forEach(c => {
      if (!c.alive) return
      this.position(c, p)
      if ((p.x - ox) * dx + (p.z - oz) * dz < front) { c.alive = false; cb(p.x, p.z) }
    })
  }

  reset() { for (const c of this.cars) c.alive = true }

  private position(c: Car, out: THREE.Vector3, heading?: { a: number }) {
    const r = this.roads[c.road]
    const s = Math.max(0, Math.min(r.len - 0.01, c.s))
    let lo = 0, hi = r.cum.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (r.cum[mid] <= s) lo = mid; else hi = mid }
    const t = (s - r.cum[lo]) / Math.max(r.cum[hi] - r.cum[lo], 0.001)
    const ax = r.pts[lo * 2], az = r.pts[lo * 2 + 1], bx = r.pts[hi * 2], bz = r.pts[hi * 2 + 1]
    let dx = bx - ax, dz = bz - az
    const l = Math.hypot(dx, dz) || 1
    dx /= l; dz /= l
    if (c.dir < 0) { dx = -dx; dz = -dz }
    // keep right
    const off = Math.min(c.lane, r.w * 0.35)
    out.set(ax + (bx - ax) * t - dz * off, 0.12, az + (bz - az) * t + dx * off)
    if (heading) heading.a = Math.atan2(-dz, dx)
    return out
  }

  update(dt: number, _engine: Engine) {
    const h = { a: 0 }
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i]
      if (!c.alive) {
        this.m.makeScale(0, 0, 0)
        this.body.setMatrixAt(i, this.m)
        this.lights.setMatrixAt(i * 2, this.m)
        this.lights.setMatrixAt(i * 2 + 1, this.m)
        continue
      }
      const r = this.roads[c.road]
      c.s += c.speed * dt * c.dir
      if (c.s > r.len || c.s < 0) {
        // continue on a random road nearby (simple: wrap to another road)
        c.road = (c.road + 1 + Math.floor(Math.random() * 7)) % this.roads.length
        c.dir = Math.random() < 0.5 ? 1 : -1
        c.s = c.dir > 0 ? 0 : this.roads[c.road].len
        c.speed = this.roads[c.road].speed * (0.55 + Math.random() * 0.35)
      }
      this.position(c, this.v, h)
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, h.a)
      this.m.compose(this.v, this.q, this.s)
      this.body.setMatrixAt(i, this.m)
      if (this.night > 0.2) {
        const fx = Math.cos(h.a), fz = -Math.sin(h.a)
        this.m.compose(this.v.clone().add(new THREE.Vector3(fx * 2.4, 0.9, fz * 2.4)), this.q, new THREE.Vector3(1.6, 1, 2.2))
        this.lights.setMatrixAt(i * 2, this.m)
        this.m.compose(this.v.clone().add(new THREE.Vector3(-fx * 2.3, 0.9, -fz * 2.3)), this.q, new THREE.Vector3(0.9, 1, 1.7))
        this.lights.setMatrixAt(i * 2 + 1, this.m)
      }
    }
    this.body.instanceMatrix.needsUpdate = true
    if (this.night > 0.2) this.lights.instanceMatrix.needsUpdate = true
  }
}
