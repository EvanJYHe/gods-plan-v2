import * as THREE from 'three'
import { DRY, type Flood } from './flood'

/**
 * Things the flood carries: cars and chunks of buildings, moved on the CPU by the simulated current. They fall into
 * the water, bob and tumble on its surface, drift with the flow and are left stranded where it drains away.
 */

const MAX = 1200

export interface FlotsamItem {
  x: number; y: number; z: number
  vx?: number; vy?: number; vz?: number
  sx: number; sy: number; sz: number
  r: number; g: number; b: number
  /** fraction that floats above the water line (0 sinks, 1 rides on top) */
  float?: number
}

export class Flotsam {
  readonly mesh: THREE.InstancedMesh
  private n = 0
  private p = new Float32Array(MAX * 3)
  private vel = new Float32Array(MAX * 3)
  private size = new Float32Array(MAX * 3)
  private rot = new Float32Array(MAX * 4) // yaw, spin, pitch, roll phase
  private flt = new Float32Array(MAX)
  private grounded = new Uint8Array(MAX)
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private e = new THREE.Euler()
  private sv = new THREE.Vector3()
  private pv = new THREE.Vector3()
  private s = { eta: 0, h: 0, vx: 0, vz: 0, bed: 0 }

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1)
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 }), MAX)
    this.mesh.count = 0
    this.mesh.frustumCulled = false
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1))
    scene.add(this.mesh)
  }

  add(it: FlotsamItem) {
    // when full, recycle a stranded one
    let i = this.n
    if (i >= MAX) {
      i = Math.floor(Math.random() * MAX)
    } else this.n++
    this.p[i * 3] = it.x; this.p[i * 3 + 1] = it.y; this.p[i * 3 + 2] = it.z
    this.vel[i * 3] = it.vx ?? 0; this.vel[i * 3 + 1] = it.vy ?? 0; this.vel[i * 3 + 2] = it.vz ?? 0
    this.size[i * 3] = it.sx; this.size[i * 3 + 1] = it.sy; this.size[i * 3 + 2] = it.sz
    this.rot[i * 4] = Math.random() * Math.PI * 2
    this.rot[i * 4 + 1] = (Math.random() - 0.5) * 1.5
    this.rot[i * 4 + 2] = Math.random() * 10
    this.rot[i * 4 + 3] = 0
    this.flt[i] = it.float ?? 0.6
    this.grounded[i] = 0
    this.mesh.setColorAt(i, new THREE.Color(it.r, it.g, it.b))
    this.mesh.instanceColor!.needsUpdate = true
    this.mesh.count = this.n
  }

  update(dt: number, t: number, f: Flood) {
    const s = this.s
    for (let i = 0; i < this.n; i++) {
      const k = i * 3
      let x = this.p[k], y = this.p[k + 1], z = this.p[k + 2]
      let vx = this.vel[k], vy = this.vel[k + 1], vz = this.vel[k + 2]
      const sy = this.size[k + 1]
      const w = f.sample(x, z, s)
      let tilt = 0
      if (w && w.h > DRY + sy * 0.25) {
        // in the water: dragged by the current, buoyed to the surface, bobbing and tumbling with the chop
        const draft = sy * (0.5 - this.flt[i])
        const ph = this.rot[i * 4 + 2]
        const target = w.eta + 0.2 - draft + Math.sin(t * 1.7 + ph) * 0.35
        const a = Math.min(1, dt * 1.6)
        vx += (w.vx - vx) * a
        vz += (w.vz - vz) * a
        if (y > target + 0.5) vy -= 18 * dt
        else vy += ((target - y) * 6 - vy * 2.5) * dt
        const sp = Math.hypot(w.vx, w.vz)
        this.rot[i * 4] += this.rot[i * 4 + 1] * dt * (0.3 + sp * 0.05)
        tilt = Math.min(0.5, 0.08 + sp * 0.012)
        this.grounded[i] = 0
      } else {
        // airborne or stranded: fall to the ground (or a roof) and drag to a stop
        // land on a roof only from above it; beside a tower (interpolated bed) it falls to the street
        const nb = f.bedAt(x, z)
        const roof = nb > 1 && y > nb + sy * 0.4 ? nb : 0.3
        const ground = roof + sy * 0.5 - 0.3
        vy -= 18 * dt
        if (y + vy * dt <= ground) {
          y = ground; vy = 0
          vx *= Math.exp(-dt * 4); vz *= Math.exp(-dt * 4)
          this.grounded[i] = 1
        }
        tilt = this.grounded[i] ? 0.12 : 0.3
      }
      x += vx * dt; y += vy * dt; z += vz * dt
      this.p[k] = x; this.p[k + 1] = y; this.p[k + 2] = z
      this.vel[k] = vx; this.vel[k + 1] = vy; this.vel[k + 2] = vz
      const ph = this.rot[i * 4 + 2]
      this.e.set(Math.sin(t * 1.3 + ph) * tilt, this.rot[i * 4], Math.cos(t * 1.1 + ph * 1.7) * tilt, 'YXZ')
      this.q.setFromEuler(this.e)
      this.m.compose(this.pv.set(x, y, z), this.q, this.sv.set(this.size[k], sy, this.size[k + 2]))
      this.mesh.setMatrixAt(i, this.m)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.mesh.dispose()
  }
}
