import * as THREE from 'three'
import type { Engine } from '../engine'
import { Whitewater, type Splash } from './whitewater'
import { DRY, Flood } from './flood'
import { FloodSurface } from './floodSurface'
import type { FloodInit, FloodResult, FloodStep } from './floodWorker'
import { Flotsam } from './flotsam'
import { type Disasters, type Event, rand, easeIn, stepLandmarks } from './disasters'

/**
 * A tsunami out of Lake Ontario toward the clicked point, as a shallow-water simulation (fx/flood.ts) over a 5 km
 * square: a long swell rises on the open lake, steepens over the shallows into a breaking bore, crashes over the
 * waterfront and floods down the streets. Water piles against the towers and knocks the weaker buildings down (opening
 * new channels), carries cars and wreckage, sloshes back to the lake and drains, leaving the city soaked.
 */

const N = 512          // cells per side
const CELL = 10        // metres
const FRONT = 1000     // the swell's front starts this far out from the shore (m)
const HEIGHT = 72      // swell height over open water (m)
const END = 78         // seconds until the water is gone

let current: Tsunami | null = null

export class Tsunami implements Event {
  done = false
  readonly flood: Flood
  private surface: FloodSurface
  private flotsam: Flotsam
  private ww: Whitewater
  private wetTex: THREE.DataTexture
  private wetData: Uint8Array
  private t0: number
  private acc = 0
  private frame = 0
  private roar: ReturnType<Engine['sound']['wave']>
  private near = 0
  private sprayAcc = 0
  private dir: THREE.Vector2
  /** per building: strength, strongest load so far, deepest water against it, wetness already applied, state */
  private strength: Float32Array
  private load: Float32Array
  private depth: Float32Array
  private wetSent: Float32Array
  private failed: Uint8Array
  private touched: number[] = []
  private cells = new Map<number, number[]>()
  private sinking: { cells: number[]; from: number; to: number; t0: number; dur: number }[] = []
  private tileDone: Uint8Array
  private disposed = false
  private phase = Math.random() * 6.28
  private s = { x: 0, z: 0 }
  stats = { failed: 0, cars: 0, stepMs: 0, frameMs: 0, steps: 0 }
  /** in real time the solver runs in a worker; film mode (manual stepping) solves in step with each frame */
  private worker: Worker | null = null
  private inflight = false
  private result: FloodResult | null = null
  private sentDt = 0
  private beds: [Int32Array, number][] = []
  private wakes: [number, number, number, number][] = []

  constructor(private d: Disasters, target: THREE.Vector3) {
    const e = d.e
    current?.cleanup()
    current = this
    this.t0 = e.time
    // the wave rises out on the open lake, south of the waterfront, aimed at the target
    let shore = target.z
    for (let z = target.z; z < target.z + 4000; z += 10) if (d.mask.isWater(target.x, z)) { shore = z; break }
    const origin = new THREE.Vector2(target.x * 0.85, Math.max(2500, shore + 1500))
    this.dir = new THREE.Vector2(target.x - origin.x, target.z - origin.y).normalize()
    const z1 = shore + FRONT + 950
    const f = this.flood = new Flood(N, CELL, target.x - (N * CELL) / 2, z1 - N * CELL)
    const tA = performance.now()
    f.terrain((x, z) => d.mask.isWater(x, z), Math.floor(this.phase * 100))
    this.rasterize()
    this.swell(target, shore)
    for (let i = 0; i < N; i++) f.inflowVar[i] = Math.max(0.3, 1 + 0.4 * this.clump(f.cx(i) * 1.3, 240, 5))
    const nb = e.buildings.count
    this.strength = new Float32Array(nb)
    this.load = new Float32Array(nb)
    this.depth = new Float32Array(nb)
    this.wetSent = new Float32Array(nb)
    this.failed = new Uint8Array(nb)
    e.buildings.info.forEach((b, i) => {
      // small and low buildings give way; towers stand and get soaked
      this.strength[i] = 900 * (b.r + 6) * Math.pow(b.top + 6, 1.25)
    })
    this.tileDone = new Uint8Array((N / 4) * (N / 4))
    if (!e.manual && typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./floodWorker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent<FloodResult>) => { this.result = ev.data; this.inflight = false }
      const fields: FloodInit['fields'] = {}
      for (const k of ['b', 'h', 'u', 'v', 'foam', 'maxH', 'bid', 'land', 'shore', 'rest', 'inflowVar'] as const) fields[k] = f[k].slice()
      const init: FloodInit = { type: 'init', n: N, cell: CELL, x0: f.x0, z0: f.z0, g: f.g, rect: [f.i0, f.i1, f.j0, f.j1], fields }
      this.worker.postMessage(init, Object.values(fields).map(a => a.buffer))
    }
    this.surface = new FloodSurface(f, e.water)
    e.scene.add(this.surface.mesh)
    this.flotsam = new Flotsam(e.scene)
    this.ww = new Whitewater(e.scene, e.water)
    // the static lake gives way to the simulation inside its box
    e.water.uFloodBox.value.set(f.x0 + CELL, f.z0 + CELL, f.x0 + (N - 1) * CELL, f.z0 + (N - 1) * CELL)
    // ground wetness from the deepest water seen
    this.wetData = new Uint8Array(N * N * 4)
    this.wetTex = new THREE.DataTexture(this.wetData, N, N, THREE.RGBAFormat)
    this.wetTex.magFilter = this.wetTex.minFilter = THREE.LinearFilter
    this.wetTex.needsUpdate = true
    e.ground.uWetTex.value = this.wetTex
    e.ground.uWetBox.value.set(f.x0, f.z0, N * CELL, N * CELL)
    e.ground.uWaveWet.value = 1
    // a rebuild drops the event without telling it: wrap Disasters.rebuild (once) so the water and wreckage go with it,
    // and, as a fallback, notice the wetness fading
    const dd = d as Disasters & { __tsunamiHook?: boolean }
    if (!dd.__tsunamiHook) {
      dd.__tsunamiHook = true
      const rebuild = d.rebuild.bind(d)
      d.rebuild = () => { current?.cleanup(); rebuild() }
    }
    this.surface.mesh.onBeforeRender = () => { if (e.ground.uWaveWet.value < 0.999) this.cleanup() }
    this.flotsam.mesh.onBeforeRender = () => { if (e.ground.uWaveWet.value < 0.999) this.cleanup(true) }
    console.debug(`tsunami setup ${(performance.now() - tA).toFixed(0)} ms`)
    this.roar = e.sound.wave(END)
    e.sound.rumble(10, 0.35)
    // the disaster-film shot: above the waterfront, looking out over the lake at the water coming in
    e.rig.flyTo({ x: target.x - this.dir.x * 300, z: shore - 200, distance: 2300, yaw: Math.PI + 0.55, pitch: 0.24 }, 2.8)
  }

  /** Buildings and landmarks into the bed: roofs rasterized from the city mesh, so footprints are exact. */
  private rasterize() {
    const e = this.d.e, f = this.flood
    const geo = e.buildings.mesh.geometry
    const pos = geo.getAttribute('position')
    const info = geo.getAttribute('aInfo')
    const bld = geo.getAttribute('aBuilding')
    const P = pos.array as ArrayLike<number>, I = info?.array as ArrayLike<number> | undefined, B = bld?.array as ArrayLike<number> | undefined
    const idx = geo.index?.array as ArrayLike<number> | undefined
    const tris = (idx ? idx.length : pos.count) / 3
    const x0 = f.x0, z0 = f.z0, c = CELL, n = N
    const vi = (k: number) => (idx ? idx[k] : k)
    if (I && B) {
      for (let t = 0; t < tris; t++) {
        const a = vi(t * 3), b = vi(t * 3 + 1), cc = vi(t * 3 + 2)
        if (I[a * 4 + 2] < 0.5) continue // walls
        const ax = (P[a * 3] - x0) / c - 0.5, az = (P[a * 3 + 2] - z0) / c - 0.5
        const bx = (P[b * 3] - x0) / c - 0.5, bz = (P[b * 3 + 2] - z0) / c - 0.5
        const cx = (P[cc * 3] - x0) / c - 0.5, cz = (P[cc * 3 + 2] - z0) / c - 0.5
        const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx))), maxX = Math.min(n - 1, Math.floor(Math.max(ax, bx, cx)))
        const minZ = Math.max(0, Math.ceil(Math.min(az, bz, cz))), maxZ = Math.min(n - 1, Math.floor(Math.max(az, bz, cz)))
        const y = P[a * 3 + 1], id = B[a]
        const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
        if (Math.abs(area) < 1e-9) continue
        // tiny triangles still mark the cell they sit in
        const mx = Math.round((ax + bx + cx) / 3), mz = Math.round((az + bz + cz) / 3)
        if (mx >= 0 && mz >= 0 && mx < n && mz < n) f.obstacle(mz * n + mx, y, id)
        for (let j = minZ; j <= maxZ; j++) for (let i = minX; i <= maxX; i++) {
          const w0 = ((bx - i) * (cz - j) - (bz - j) * (cx - i)) / area
          const w1 = ((cx - i) * (az - j) - (cz - j) * (ax - i)) / area
          const w2 = 1 - w0 - w1
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) f.obstacle(j * n + i, y, id)
        }
      }
    } else {
      // fallback if the mesh layout changes: square footprints from the building summary
      e.buildings.info.forEach((b, id) => {
        const r = b.r * 0.75
        for (let j = Math.floor((b.cz - r - z0) / c); j <= (b.cz + r - z0) / c; j++) for (let i = Math.floor((b.cx - r - x0) / c); i <= (b.cx + r - x0) / c; i++) {
          if (i >= 0 && j >= 0 && i < n && j < n) f.obstacle(j * n + i, b.top, id)
        }
      })
    }
    for (const l of e.landmarks) {
      const r = Math.max(8, l.r * 0.8)
      for (let j = Math.floor((l.z - r - z0) / c); j <= (l.z + r - z0) / c; j++) for (let i = Math.floor((l.x - r - x0) / c); i <= (l.x + r - x0) / c; i++) {
        if (i < 0 || j < 0 || i >= n || j >= n) continue
        if (Math.hypot(f.cx(i) - l.x, f.cz(j) - l.z) < r) f.obstacle(j * n + i, l.h, -2)
      }
    }
    for (let k = 0; k < n * n; k++) {
      const id = f.bid[k]
      if (id < 0) continue
      let a = this.cells.get(id)
      if (!a) this.cells.set(id, (a = []))
      a.push(k)
    }
  }

  /** Smooth random -1..1 along the front, with features about `scale` metres apart. */
  private clump(x: number, scale: number, seed: number) {
    const t = x / scale + seed * 17.3 + this.phase * 5
    const i = Math.floor(t), k = t - i
    const r = (m: number) => { const v = Math.sin((m + seed * 101) * 127.1 + this.phase * 13.7) * 43758.5453; return (v - Math.floor(v)) * 2 - 1 }
    const w = k * k * (3 - 2 * k)
    return r(i) * (1 - w) + r(i + 1) * w
  }

  /** The swell: a long hump of water on the open lake with the velocity of a wave running toward the shore. */
  private swell(target: THREE.Vector3, shore: number) {
    const f = this.flood, n = N, dir = this.dir
    const fz = shore + FRONT
    const fx = target.x + (fz - target.z) * (dir.x / dir.y)
    const W = (n * CELL) / 2 - 250
    const sp = new Float32Array(n * n)
    let i0 = n, i1 = -1, j0 = n, j1 = -1
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i
      if (f.land[k] || f.bid[k] !== -1) continue
      const px = f.cx(i) - fx, pz = f.cz(j) - fz
      const s = px * dir.x + pz * dir.y // + ahead of the front
      const lat = Math.abs(-px * dir.y + pz * dir.x)
      if (s > 0) continue
      const rise = THREE.MathUtils.smoothstep(-s, 0, 260)
      const body = Math.exp(-Math.max(0, -s - 200) / 950)
      const env = 1 - THREE.MathUtils.smoothstep(lat, W - 1100, W)
      // the front varies a little along its length so it breaks unevenly
      const sl = -px * dir.y + pz * dir.x
      // clumps of 100-300 m: some parts of the front much higher and further ahead than others
      const vary = Math.max(0.3, 1 + 0.5 * this.clump(sl, 260, 0) + 0.25 * this.clump(sl, 120, 1))
      // the front itself is ragged, so it reaches the shore unevenly
      const lag = 240 * this.clump(sl, 230, 2) + 90 * this.clump(sl, 110, 3)
      const rise2 = THREE.MathUtils.smoothstep(-s - lag, 0, 260)
      const eta = HEIGHT * Math.min(rise, rise2 + 0.0) * body * env * vary
      if (eta < 0.01) continue
      const D = f.rest[k]
      f.h[k] += eta
      sp[k] = 2 * (Math.sqrt(f.g * (D + eta)) - Math.sqrt(f.g * D)) * (1.05 + 0.2 * this.clump(sl, 180, 4))
      i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j)
    }
    for (let j = 0; j < n; j++) for (let i = 1; i < n; i++) f.u[j * (n + 1) + i] = 0.5 * (sp[j * n + i - 1] + sp[j * n + i]) * dir.x
    for (let j = 1; j < n; j++) for (let i = 0; i < n; i++) f.v[j * n + i] = 0.5 * (sp[(j - 1) * n + i] + sp[j * n + i]) * dir.y
    f.wake(i0 - 2, i1 + 2, j0 - 2, j1 + 2)
  }

  update(dt: number, t: number) {
    if (this.disposed) { this.done = true; return }
    const e = this.d.e
    const f = this.flood
    const age = t - this.t0
    const tA = performance.now()
    stepLandmarks(this.d, t)
    // late in the event the water runs back to the lake and drains away
    f.slope = 0.006 * THREE.MathUtils.smoothstep(age, 24, 40)
    f.drain = 0.05 * THREE.MathUtils.smoothstep(age, 36, 50) + 0.5 * THREE.MathUtils.smoothstep(age, 52, 68)
    f.calm = 0.6 * THREE.MathUtils.smoothstep(age, END - 16, END - 2)
    // the long surge behind the first wave, fed in from the open lake and dying away
    f.inflow = HEIGHT * 0.6 * (age < 6 ? 1 : Math.exp(-(age - 6) / 9))
    f.inflowV = 2 * (Math.sqrt(f.g * (55 + f.inflow)) - Math.sqrt(f.g * 55))
    this.acc += dt
    let stepped = false
    if (this.worker) {
      const r = this.result
      if (r) {
        this.result = null
        for (const k of Flood.LIVE) f[k] = r.fields[k]
        ;[f.i0, f.i1, f.j0, f.j1] = r.rect
        // edits made since that step was sent are reapplied on top of it
        for (const [cells, y] of this.beds) for (const c of cells) if (f.b[c] > y) f.b[c] = y
        this.stats.stepMs = this.stats.stepMs * 0.9 + r.ms * 0.1
        this.stats.steps++
        this.react(this.sentDt, t)
        stepped = true
      }
      if (!this.inflight && this.acc > 0.004) {
        const msg: FloodStep = { type: 'step', dt: this.acc, slope: f.slope, drain: f.drain, calm: f.calm, inflow: f.inflow, inflowV: f.inflowV, beds: this.beds, wakes: this.wakes }
        this.worker.postMessage(msg)
        this.beds = []
        this.wakes = []
        this.inflight = true
        this.sentDt = this.acc
        this.acc = 0
      }
    } else if (this.acc >= 1 / 70) {
      // film mode: solve in step with the frame (deterministic)
      const steps = Math.ceil(this.acc / 0.034)
      const tS = performance.now()
      for (let s = 0; s < steps; s++) f.step(this.acc / steps)
      f.foamStep(this.acc)
      this.stats.stepMs = this.stats.stepMs * 0.9 + (performance.now() - tS) * 0.1
      this.stats.steps++
      this.react(this.acc, t)
      this.acc = 0
      stepped = true
    }
    this.flotsam.update(dt, t, f)
    this.ww.update(t, 1 - e.atmosphere.night * 0.6)
    if (stepped) this.surface.upload()
    const a = e.atmosphere
    this.surface.light(1 - a.night * 0.6, a.sun.color.clone().multiplyScalar(a.sun.intensity / 3))
    // collapsing buildings settle into the bed over their fall, letting the water through
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const s = this.sinking[i]
      const k = Math.min(1, Math.max(0, (t - s.t0) / s.dur))
      const y = s.from + (s.to - s.from) * easeIn(k)
      this.lowerBed(s.cells, y)
      if (k >= 1) this.sinking.splice(i, 1)
    }
    if (++this.frame % 8 === 0) this.updateWet()
    // sound and shake follow how close the breaking water is
    this.roar?.set(this.near * 0.9 + 0.1 * (1 - f.calm), this.near)
    if (this.near > 0.35) e.rig.shake(dt * this.near * 0.5)
    this.stats.frameMs = this.stats.frameMs * 0.9 + (performance.now() - tA) * 0.1
    if (age > END) this.cleanup(false)
  }

  /** What the water does to the city this step: loads on buildings, spray, cars swept up, the roar. */
  private react(dt: number, t: number) {
    const e = this.d.e, f = this.flood, n = N, h = f.h, b = f.b, bid = f.bid
    const I0 = Math.max(1, f.i0 - 1), I1 = Math.min(n - 2, f.i1 + 1), J0 = Math.max(1, f.j0 - 1), J1 = Math.min(n - 2, f.j1 + 1)
    const touched = this.touched
    touched.length = 0
    const load = this.load
    const v = this.s
    let sprayBudget = 22
    const NB = [-1, 1, -n, n]
    for (let j = J0; j <= J1; j++) {
      for (let i = I0; i <= I1; i++) {
        const c = j * n + i
        const hh = h[c]
        if (hh < 0.4) continue
        if (bid[c] !== -1) {
          // water running over a roof
          const id = bid[c]
          if (id >= 0 && !this.failed[id]) {
            f.vel(c, v)
            if (load[id] === 0) touched.push(id)
            load[id] += (hh * (v.x * v.x + v.z * v.z) + 4.9 * hh * hh) * CELL * 0.5
            this.depth[id] = Math.max(this.depth[id], hh + 20)
          }
          continue
        }
        const eta = b[c] + hh
        let vx = NaN, vz = 0
        for (let q = 0; q < 4; q++) {
          const m = c + NB[q]
          const id = bid[m]
          if (id === -1 || b[m] <= eta - 0.2 || h[m] > DRY) continue
          if (vx !== vx) { f.vel(c, v); vx = v.x; vz = v.z }
          // flow into this wall
          const un = q === 0 ? -vx : q === 1 ? vx : q === 2 ? -vz : vz
          const ui = un > 0 ? un : 0
          if (id >= 0 && !this.failed[id]) {
            if (load[id] === 0) touched.push(id)
            load[id] += (hh * ui * ui + 4.9 * hh * hh) * CELL
            if (hh > this.depth[id]) this.depth[id] = hh
          }
          // a jet of white water thrown up the face where the water slams into it, falling back
          if (ui > 6 && hh > 1.5 && sprayBudget > 0 && Math.random() < 0.02 * (ui - 5)) {
            sprayBudget--
            const ox = q === 0 ? -1 : q === 1 ? 1 : 0, oz = q === 2 ? -1 : q === 3 ? 1 : 0
            this.jet(f.cx(i) + ox * CELL * 0.45, eta, f.cz(j) + oz * CELL * 0.45, -ox, -oz, Math.min(70, ui * rand(1.1, 1.8)), hh, vx * 0.15, vz * 0.15)
          }
        }
      }
    }
    // buildings that give way
    for (const id of touched) {
      const L = load[id]
      load[id] = 0
      const bi = e.buildings.info[id]
      const dep = this.depth[id]
      if (dep > this.wetSent[id] + 1.5) {
        this.wetSent[id] = dep
        this.d.damage(id, 0, 1.2, { wet: Math.min(1, dep / 18) })
      }
      if (L < this.strength[id] || this.failed[id]) continue
      this.failed[id] = 1
      this.stats.failed++
      const cells = this.cells.get(id) ?? []
      // which way the water pushes it
      let fx = 0, fz = 0
      for (const c of cells) for (const m of [c - 1, c + 1, c - n, c + n]) if (bid[m] === -1 && h[m] > 0.4) { f.vel(m, v); fx += v.x * h[m]; fz += v.z * h[m] }
      const dir = Math.atan2(fz, fx)
      const k = Math.min(1, dep / Math.max(4, bi.top))
      const dur = rand(1.3, 2.6)
      this.d.damage(id, rand(0, 0.25), dur, { wet: 1, collapse: rand(0.55, 1) * (0.6 + 0.4 * k), tilt: rand(0.15, 0.6), dir: dir + rand(-0.35, 0.35), ease: easeIn })
      this.sinking.push({ cells, from: 0.3 + bi.top, to: 0.3 + Math.min(3, bi.top * 0.12), t0: t + 0.15, dur: dur * 0.8 })
      if (cells.length) {
        let ci0 = n, ci1 = 0, cj0 = n, cj1 = 0
        for (const c of cells) { const ci = c % n, cj = (c / n) | 0; ci0 = Math.min(ci0, ci); ci1 = Math.max(ci1, ci); cj0 = Math.min(cj0, cj); cj1 = Math.max(cj1, cj) }
        f.wake(ci0 - 1, ci1 + 1, cj0 - 1, cj1 + 1)
        if (this.worker) this.wakes.push([ci0 - 1, ci1 + 1, cj0 - 1, cj1 + 1])
      }
      // wreckage into the water and a burst of white water
      const col = e.buildings.colors
      const cnt = Math.min(16, 3 + Math.floor(bi.r * bi.top / 1200))
      const sp = Math.hypot(fx, fz) > 0 ? 1 : 0
      for (let s = 0; s < cnt; s++) {
        const sz = rand(1.6, Math.min(5, 3 + bi.r * 0.05))
        const shade = rand(0.85, 1.15)
        this.flotsam.add({ x: bi.cx + rand(-bi.r, bi.r) * 0.7, y: rand(2, Math.min(45, Math.max(4, bi.top * 0.6))), z: bi.cz + rand(-bi.r, bi.r) * 0.7, vx: Math.cos(dir) * rand(4, 12) * sp, vy: rand(0, 6), vz: Math.sin(dir) * rand(4, 12) * sp, sx: sz * rand(0.8, 1.6), sy: sz * rand(0.35, 0.8), sz: sz * rand(0.8, 1.4), r: col[id * 3] * shade, g: col[id * 3 + 1] * shade, b: col[id * 3 + 2] * shade, float: rand(0.3, 0.7) })
      }
      for (let s = 0; s < 8; s++) {
        const a = Math.random() * Math.PI * 2
        this.splash({ x: bi.cx + Math.cos(a) * bi.r * 0.7, y: rand(2, Math.min(bi.top, 25)), z: bi.cz + Math.sin(a) * bi.r * 0.7, vx: Math.cos(dir) * rand(4, 14) + rand(-5, 5), vy: rand(8, 26), vz: Math.sin(dir) * rand(4, 14) + rand(-5, 5), life: rand(1.4, 2.6), size0: 14 + bi.r * 0.3, size1: 40 + bi.r * 1.2, r: 0.9, g: 0.92, b: 0.93, a: 0.8, drag: 0.8, gravity: 12, turb: 4, delay: rand(0, 0.6) })
      }
      if (bi.top > 25) e.sound.rumble(3, 0.12)
    }
    // the breaking front: random probes find water running fast down a steep face; spray boils off it
    const cam = e.rig.camera.position
    let near = 0
    this.sprayAcc += dt * 220
    if (I1 > I0 && J1 > J0) {
      const W = I1 - I0, H = J1 - J0
      for (let p = 0; p < 2600; p++) {
        const i = I0 + ((Math.random() * W) | 0), j = J0 + ((Math.random() * H) | 0)
        const c = j * n + i
        const hh = h[c]
        if (hh < 2 || bid[c] !== -1) continue
        f.vel(c, v)
        const sp = Math.hypot(v.x, v.z)
        if (sp < 9) continue
        const eta = b[c] + hh
        // surface drop one cell ahead along the flow
        const ai = Math.round(v.x / sp), aj = Math.round(v.z / sp)
        const m = c + ai + aj * n
        const ahead = h[m] > DRY ? b[m] + h[m] : Math.min(b[m], eta)
        const drop = eta - ahead
        if (drop < 2.2) continue
        const x = f.cx(i), z = f.cz(j)
        const dist = Math.hypot(cam.x - x, cam.y - eta, cam.z - z)
        near = Math.max(near, Math.max(0, 1 - dist / 2200) * Math.min(1, drop / 10 + hh / 40))
        if (this.sprayAcc < 1) continue
        this.sprayAcc -= 1
        const up = Math.min(30, drop * rand(0.6, 1.4) + sp * 0.2)
        // sheets of spray torn forward off the breaking lip
        for (let q = 0; q < 3; q++) this.splash({ x: x + rand(-6, 6), y: eta - drop * rand(0, 0.2), z: z + rand(-6, 6), vx: v.x * rand(0.8, 1.2) + rand(-3, 3), vy: up * rand(0.6, 1.1), vz: v.z * rand(0.8, 1.2) + rand(-3, 3), life: rand(1.2, 2), size0: rand(5, 9) + drop * 0.25, size1: rand(18, 30) + drop * 0.9, r: 0.95, g: 0.97, b: 1, a: 0.9, drag: 0.35, gravity: 13, turb: 2 })
        // a curtain of mist blowing off the lip, so the crest is torn and soft, never a clean edge
        if (drop > 6 && Math.random() < 0.7) this.splash({ x: x + v.x / sp * 6 + rand(-8, 8), y: eta + rand(-drop * 0.2, 4), z: z + v.z / sp * 6 + rand(-8, 8), vx: v.x * rand(0.5, 0.9), vy: rand(4, 12), vz: v.z * rand(0.5, 0.9), life: rand(1.8, 3), size0: 30 + drop * 1.2, size1: 80 + drop * 3.5, r: 0.95, g: 0.97, b: 1, a: 0.45, drag: 1.1, gravity: 2, turb: 7 })
      }
    }
    this.sprayAcc = Math.min(this.sprayAcc, 20)
    this.near = this.near * 0.85 + near * 0.15
    // cars caught by the water (checked over 40 m tiles, a few per step)
    let calls = 24
    const T = N / 4
    for (let tj = (J0 >> 2); tj <= (J1 >> 2) && calls > 0; tj++) for (let ti = (I0 >> 2); ti <= (I1 >> 2) && calls > 0; ti++) {
      const tk = tj * T + ti
      if (this.tileDone[tk]) continue
      const c = (tj * 4 + 2) * n + ti * 4 + 2
      if (!f.land[c] || h[c] < 0.7) continue
      this.tileDone[tk] = 1
      calls--
      e.traffic.inCircle(f.cx(ti * 4 + 1.5), f.cz(tj * 4 + 1.5), 29, (px, pz) => {
        this.stats.cars++
        const cc = new THREE.Color().setHSL(Math.random(), rand(0, 0.6), rand(0.15, 0.75))
        this.flotsam.add({ x: px, y: 1, z: pz, vy: rand(0, 3), sx: 4.4, sy: 1.5, sz: 1.9, r: cc.r, g: cc.g, b: cc.b, float: rand(0.35, 0.6) })
      })
    }
  }

  /** A jet of water thrown up a wall: streaks that rise and fall back, and a little mist. (dx, dz) points off the wall. */
  private jet(x: number, y: number, z: number, dx: number, dz: number, up: number, hh: number, cx: number, cz: number) {
    const sx = -dz, sz = dx // along the wall
    const n = 6 + Math.floor(Math.random() * 4)
    for (let k = 0; k < n; k++) {
      const along = rand(-1, 1)
      const u = up * rand(0.55, 1.05)
      this.splash({ x: x + sx * along * 6, y: y + rand(0, 4), z: z + sz * along * 6, vx: dx * rand(2, 9) + sx * along * rand(3, 8) + cx, vy: u, vz: dz * rand(2, 9) + sz * along * rand(3, 8) + cz, life: rand(1.6, 2.8), size0: rand(8, 14) + hh * 0.25, size1: rand(30, 50) + u * 0.8, r: 0.95, g: 0.97, b: 1, a: 0.92, drag: 0.25, gravity: 16, turb: 2, delay: rand(0, 0.15) })
    }
    if (Math.random() < 0.5) this.splash({ x, y: y + up * 0.4, z, vx: dx * 4 + cx, vy: up * 0.25, vz: dz * 4 + cz, life: rand(2.4, 3.6), size0: 25 + hh * 0.5, size1: 70 + up * 1.2, r: 0.95, g: 0.97, b: 1, a: 0.3, drag: 1.1, gravity: 1.5, turb: 6, delay: 0.3 })
  }

  /** Whitewater: anything with heavy drag is mist, the rest are torn sheets and jets. */
  private splash(p: Splash & { r?: number; g?: number; b?: number; a?: number; turb?: number }) {
    this.ww.emit({ ...p, mist: (p.drag ?? 0) >= 1 ? 1 : 0, alpha: p.a ?? 0.9 }, this.d.e.time)
  }

  private lowerBed(cells: number[] | Int32Array, y: number) {
    const b = this.flood.b
    let any = false
    for (const c of cells) if (b[c] > y) { b[c] = y; any = true }
    if (any && this.worker) this.beds.push([Int32Array.from(cells), y])
  }

  /** Ground wetness: soaked where the water reached, silt where it ran deep. */
  private updateWet() {
    const f = this.flood, w = this.wetData, m = f.maxH
    for (let k = 0; k < N * N; k++) {
      const x = m[k]
      if (x <= 0) continue
      w[k * 4] = Math.min(255, 40 + x * 600)
      w[k * 4 + 1] = Math.min(255, x * 40)
    }
    this.wetTex.needsUpdate = true
  }

  /** Remove the water (and, on a rebuild or a new tsunami, the wreckage too). */
  cleanup(all = true) {
    const e = this.d.e
    if (!this.disposed) {
      this.disposed = true
      this.done = true
      this.surface.dispose()
      this.worker?.terminate()
      this.worker = null
      e.water.uFloodBox.value.set(0, 0, 0, 0)
      this.roar?.set(0, 0)
      this.updateWet()
    }
    if (all) {
      this.flotsam.dispose()
      this.ww.dispose()
      if (current === this) current = null
    }
  }
}
