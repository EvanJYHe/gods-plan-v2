import * as THREE from 'three'
import type { Engine } from '../engine'
import { Kind } from './particles'
import { WaterMask } from '../city/mask'
import { Fireball } from './meshes'
import { Tsunami } from './tsunami'

export type Power = 'nuke' | 'tsunami' | 'meteor'

/**
 * The disasters' own random numbers (mulberry32), reseeded from Math.random() at each trigger: good quality even when
 * the film recorder swaps Math.random for a weak seeded generator, and still deterministic under that seed.
 */
let seed = 0x2f6b1c3d
export const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
export const reseed = () => { seed = (Math.random() * 4294967296) | 0 }
export const rand = (a: number, b: number) => a + random() * (b - a)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const easeOut = (k: number) => 1 - (1 - k) ** 3
export const easeIn = (k: number) => k * k * k
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2)
/** falling under gravity: accelerating, but quicker off the mark than a cubic */
const fall = (k: number) => k * k

interface Anim {
  i: number
  t0: number
  dur: number
  collapse: number
  tilt: number
  dir: number
  scorch: number
  burn: number
  wet: number
  /** cells blown out of the structure, 0..1 (blast side, top and corners first) */
  shatter: number
  ease: (k: number) => number
  from: [number, number, number, number, number, number, number]
}

interface Fire { x: number; y: number; z: number; until: number; size: number; next: number; smoke: number }

const CONCRETE = [0.46, 0.45, 0.43]

const randomDir = () => {
  const u = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt(1 - u * u)
  return new THREE.Vector3(Math.cos(a) * r, u, Math.sin(a) * r)
}

/** Shared choreography: damage animations, lingering fires, impact marks and the event list. */
export class Disasters {
  private anims: Anim[] = []
  private fires: Fire[] = []
  private events: Event[] = []
  private impactSlot = 0
  readonly mask: WaterMask
  readonly light: THREE.PointLight
  private lastCentre = new THREE.Vector3()
  private rebuilding: { t0: number; from: Float32Array; from2: Float32Array; delays: Float32Array } | null = null

  constructor(readonly e: Engine) {
    this.mask = new WaterMask(e.data)
    this.light = new THREE.PointLight(0xffaa55, 0, 0, 2)
    e.scene.add(this.light)
    Fireball.warm(e.scene)
  }

  busy() { return this.events.length > 0 }

  radius(p: Power) {
    return p === 'nuke' ? 1150 : p === 'meteor' ? 420 : 260
  }

  trigger(p: Power, at: THREE.Vector3, big = false) {
    reseed()
    this.lastCentre.copy(at)
    this.rebuilding = null
    if (p === 'nuke') this.events.push(new Nuke(this, at, big ? 1.5 : 1))
    else if (p === 'meteor') this.events.push(new Meteor(this, at))
    else this.events.push(new Tsunami(this, at))
    this.e.events?.onBusy?.(true)
  }

  /** Animate a building's damage to a target (never undoing damage it already has). */
  damage(i: number, delay: number, dur: number, d: Partial<Omit<Anim, 'i' | 't0' | 'dur' | 'from' | 'ease'>> & { ease?: (k: number) => number }) {
    const s = this.e.buildings.state, s2 = this.e.buildings.state2
    // anything that brings a building down also breaks it apart
    const shatter = Math.max(d.shatter ?? (d.collapse ?? 0) * 0.35, s2[i * 4 + 3])
    this.anims.push({
      i, t0: this.e.time + delay, dur,
      collapse: Math.max(d.collapse ?? 0, s[i * 4]),
      tilt: Math.abs(d.tilt ?? 0) > Math.abs(s[i * 4 + 1]) ? d.tilt! : s[i * 4 + 1],
      dir: Math.abs(d.tilt ?? 0) > Math.abs(s[i * 4 + 1]) ? d.dir ?? 0 : s[i * 4 + 2],
      scorch: Math.max(d.scorch ?? 0, s[i * 4 + 3]),
      burn: Math.max(d.burn ?? 0, s2[i * 4 + 1]),
      wet: Math.max(d.wet ?? 0, s2[i * 4]),
      shatter,
      ease: d.ease ?? easeInOut,
      from: [s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3], s2[i * 4 + 1], s2[i * 4], s2[i * 4 + 3]],
    })
  }

  /** Brief shiver while a shock passes. */
  shiver(i: number, delay: number, amount: number) {
    this.anims.push({ i, t0: this.e.time + delay, dur: 0.9, collapse: -1, tilt: amount, dir: 0, scorch: 0, burn: 0, wet: 0, shatter: 0, ease: k => k, from: [0, 0, 0, 0, 0, 0, 0] })
  }

  addFire(x: number, y: number, z: number, seconds: number, size: number, smoke = 1) {
    if (this.fires.length > 900) this.fires.shift()
    this.fires.push({ x, y, z, until: this.e.time + seconds, size, next: this.e.time + random() * 0.5, smoke })
  }

  impact(x: number, z: number, radius: number) {
    const slot = this.impactSlot++ % this.e.ground.uImpacts.value.length
    const v = this.e.ground.uImpacts.value[slot]
    v.set(x, z, radius, 0)
    this.e.ground.uImpactGlow.value[slot] = 0
    return slot
  }

  /** One chunk of building i: a piece of facade (with its windows) or bare concrete, a block or a slab. */
  chunk(i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, delay: number, hot: number, big = 1) {
    const c = this.e.buildings.colors
    const sc = this.e.buildings.state[i * 4 + 3]
    const s = (1.6 + 6.5 * random() ** 2.2) * big
    const slab = random() < 0.3
    const facade = random() < 0.35
    const shade = rand(0.75, 1.0) * (1 - 0.6 * sc * random())
    // most of a building is concrete, dusted grey as it breaks; some pieces keep their facade
    const col = facade ? [c[i * 3] * 0.6 + 0.18, c[i * 3 + 1] * 0.6 + 0.17, c[i * 3 + 2] * 0.6 + 0.16] : CONCRETE
    this.e.debris.emit({
      x, y, z, vx, vy, vz,
      sx: slab ? s * rand(1.3, 1.9) : s * rand(0.7, 1.2), sy: slab ? s * rand(0.3, 0.45) : s * rand(0.6, 1.1), sz: slab ? s * rand(1.1, 1.6) : s * rand(0.7, 1.2),
      r: col[0] * shade, g: col[1] * shade, b: col[2] * shade,
      hot: random() < hot ? 1 : 0, delay, facade: facade ? 1 : 0, pile: true, life: Infinity,
    })
  }

  /** Throw chunks of a building outward from (ox, oz). */
  burst(i: number, ox: number, oz: number, power: number, count: number, hot = 0, delay = 0) {
    const b = this.e.buildings.info[i]
    const dx = b.cx - ox, dz = b.cz - oz
    const len = Math.hypot(dx, dz) || 1
    for (let k = 0; k < count; k++) {
      const a = random() * Math.PI * 2, rr = random() * b.r
      const p = power * rand(0.35, 1)
      this.chunk(i, b.cx + Math.cos(a) * rr, rand(b.base + 2, Math.max(b.top, 4)), b.cz + Math.sin(a) * rr,
        (dx / len) * p + rand(-6, 6), rand(2, 12) + power * rand(0.05, 0.3), (dz / len) * p + rand(-6, 6), delay + rand(0, 0.25), hot)
    }
  }

  /**
   * Chunks shed as a building comes down: they break off at the collapse front as it descends (start..start+dur on
   * the same easing as the collapse), drop around the base and pile up there.
   */
  shed(i: number, start: number, dur: number, ease: (k: number) => number, count: number, ox: number, oz: number, push = 0, hot = 0) {
    const b = this.e.buildings.info[i]
    const stump = Math.min(b.top, 3 + b.top * 0.1)
    const dx = b.cx - ox, dz = b.cz - oz
    const len = Math.hypot(dx, dz) || 1
    for (let k = 0; k < count; k++) {
      const u = random()
      const y = b.top + 2 - (b.top + 2 - stump) * ease(u) + rand(-2, 2)
      const a = random() * Math.PI * 2, rr = b.r * Math.sqrt(rand(0.1, 1))
      const out = rand(1.5, 7) + b.top * 0.02
      const p = push * rand(0.2, 1)
      this.chunk(i, b.cx + Math.cos(a) * rr, Math.max(y, 2), b.cz + Math.sin(a) * rr,
        Math.cos(a) * out + (dx / len) * p, rand(-3, 5), Math.sin(a) * out + (dz / len) * p, start + u * dur, hot, b.top > 40 ? 1.15 : 0.9)
    }
  }

  /** Dust boiling out of a collapsing building. */
  dust(i: number, delay: number, scale = 1, color = [0.62, 0.6, 0.56]) {
    const b = this.e.buildings.info[i]
    if (b.r < 9 && random() < 0.6) return
    const n = Math.min(5, 1 + Math.floor(b.r / 14))
    for (let k = 0; k < n; k++) {
      const a = random() * Math.PI * 2
      const s = rand(14, 22) + b.r * 0.8
      this.e.particles.emit({
        kind: Kind.Dust, x: b.cx + Math.cos(a) * b.r * 0.6, y: rand(2, Math.min(b.top, 24)), z: b.cz + Math.sin(a) * b.r * 0.6,
        vx: Math.cos(a) * rand(6, 18) * scale, vy: rand(2, 8) * scale, vz: Math.sin(a) * rand(6, 18) * scale,
        life: rand(5, 9), size0: s * 0.45 * scale, size1: s * 1.8 * scale, r: color[0], g: color[1], b: color[2], a: 0.7,
        drag: 0.5, buoyancy: 0.5, turb: 6, delay: delay + rand(0, 0.8),
      })
    }
  }

  rebuild() {
    for (const ev of this.events) ev.dispose?.()
    this.events = []
    const s = this.e.buildings.state, s2 = this.e.buildings.state2
    const delays = new Float32Array(this.e.buildings.count)
    const c = this.lastCentre
    this.e.buildings.info.forEach((b, i) => { delays[i] = Math.hypot(b.cx - c.x, b.cz - c.z) / 1400 + random() * 0.25 })
    this.rebuilding = { t0: this.e.time, from: s.slice(), from2: s2.slice(), delays }
    this.anims = []
    this.fires = []
    this.e.particles.clear()
    this.e.debris.clear()
    this.e.debris.uniforms.uFire.value.w = 0
    this.e.traffic.reset()
    for (const l of this.e.landmarks) l.collapse = l.tilt = l.scorch = 0
    landmarkAnims.length = 0
    this.e.shocks.length = 0
    this.light.intensity = 0
    this.e.flash.value = 0
    this.e.sound.rebuild()
    this.e.events?.onBusy?.(false)
  }

  update(dt: number, real: number) {
    const e = this.e
    const t = e.time
    for (const ev of this.events) ev.update(dt, t)
    const before = this.events.length
    this.events = this.events.filter(ev => !ev.done)
    if (before && !this.events.length) e.events?.onBusy?.(false)

    // damage animations
    if (this.anims.length) {
      const s = e.buildings.state, s2 = e.buildings.state2
      const keep: Anim[] = []
      for (const a of this.anims) {
        const k = (t - a.t0) / a.dur
        if (k < 0) { keep.push(a); continue }
        const kk = a.ease(clamp01(k))
        const i = a.i
        if (a.collapse < 0) {
          // shiver
          s2[i * 4 + 2] = k < 1 ? Math.sin(Math.PI * clamp01(k)) * a.tilt : 0
        } else {
          s[i * 4] = Math.max(s[i * 4], a.from[0] + (a.collapse - a.from[0]) * kk)
          s[i * 4 + 1] = a.from[1] + (a.tilt - a.from[1]) * kk
          s[i * 4 + 2] = a.dir
          s[i * 4 + 3] = Math.max(s[i * 4 + 3], a.from[3] + (a.scorch - a.from[3]) * clamp01(k * 3))
          s2[i * 4 + 1] = Math.max(s2[i * 4 + 1], a.from[4] + (a.burn - a.from[4]) * clamp01(k * 2))
          s2[i * 4] = Math.max(s2[i * 4], a.from[5] + (a.wet - a.from[5]) * clamp01(k * 4))
          // the structure breaks up fast, ahead of the fall
          s2[i * 4 + 3] = Math.max(s2[i * 4 + 3], a.from[6] + (a.shatter - a.from[6]) * easeOut(clamp01(k * 2.5)))
        }
        if (k < 1) keep.push(a)
      }
      this.anims = keep
      e.buildings.touch()
    }

    // embers fade on burning buildings over time
    if (t % 1 < dt) {
      const s2 = e.buildings.state2
      for (let i = 0; i < e.buildings.count; i++) if (s2[i * 4 + 1] > 0) s2[i * 4 + 1] = Math.max(0, s2[i * 4 + 1] - 0.012)
      e.buildings.touch()
    }

    // lingering fires: flames and a column of black smoke each
    for (const f of this.fires) {
      if (t > f.until || t < f.next) continue
      f.next = t + rand(0.1, 0.25)
      e.particles.emit({ kind: Kind.Fire, x: f.x + rand(-3, 3), y: f.y, z: f.z + rand(-3, 3), vy: rand(5, 10), life: rand(0.6, 1.2), size0: f.size * 0.75, size1: f.size * 0.2, r: 0.8, g: 0.8, b: 0.8, drag: 0.8, buoyancy: 4, turb: 2 })
      if (random() < 0.3 * f.smoke) {
        const tone = rand(0.09, 0.16)
        // the smoke leans off downwind and spreads as it climbs, so the columns merge into a pall over the ruins
        e.particles.emit({ kind: Kind.Smoke, x: f.x + rand(-4, 4), y: f.y + 6, z: f.z + rand(-4, 4), vx: rand(14, 22), vy: rand(9, 14), vz: rand(-8, -3), life: rand(22, 32), size0: f.size * 1.6, size1: f.size * 14, r: tone, g: tone * 0.96, b: tone * 0.92, a: 0.42, drag: 0.1, buoyancy: 1.6, turb: 30, heat: 0.1 })
      }
    }
    this.fires = this.fires.filter(f => t <= f.until)

    // the city rising back
    if (this.rebuilding) {
      const rb = this.rebuilding
      const s = e.buildings.state, s2 = e.buildings.state2
      let active = false
      for (let i = 0; i < e.buildings.count; i++) {
        const k = clamp01((t - rb.t0 - rb.delays[i]) / 1.6)
        if (k < 1) active = true
        const r = 1 - easeOut(k)
        for (let c = 0; c < 4; c++) { s[i * 4 + c] = rb.from[i * 4 + c] * r; s2[i * 4 + c] = rb.from2[i * 4 + c] * r }
      }
      e.buildings.touch()
      const g = e.ground
      for (let i = 0; i < g.uImpacts.value.length; i++) { g.uImpacts.value[i].w *= Math.exp(-real * 3); g.uImpactGlow.value[i] *= Math.exp(-real * 3) }
      g.uWaveWet.value *= Math.exp(-real * 2.5)
      if (!active) {
        this.rebuilding = null
        for (const v of g.uImpacts.value) v.set(0, 0, 0, 0)
        g.uWaveWet.value = 0
        g.uWaveFront.value = -1e6
      }
    }
    // the fireball light decays on its own
    if (!this.events.some(ev => ev instanceof Nuke)) this.light.intensity *= Math.exp(-real * 1.5)
    e.flash.value *= Math.exp(-real * 5)
    e.heat.value *= Math.exp(-real * 1.2)
  }
}

export interface Event { done: boolean; update(dt: number, t: number): void; dispose?(): void }

interface Zones { vapor: number; total: number; heavy: number; light: number }

/**
 * Damage zones by distance from the centre. Nearest the blast buildings are blown apart where they stand; then they
 * have their blast side torn open and fall, shedding chunks that pile up as rubble round their stumps; further out
 * low buildings fold, towers lose the cells facing the blast, and windows go. Chunks are budgeted to the debris pool.
 */
function blastZones(d: Disasters, at: THREE.Vector3, zones: Zones, speed: (dist: number) => number, power: number, hotDebris: number, budget: number) {
  const e = d.e
  const info = e.buildings.info
  let crunches = 0
  const vol = (i: number) => 2.4 * info[i].r * info[i].r * Math.max(info[i].top - info[i].base, 2)
  // the chunk budget, shared by volume
  let want = 0
  for (let i = 0; i < info.length; i++) {
    const b = info[i]
    if (b.top <= 0) continue
    const dist = Math.hypot(b.cx - at.x, b.cz - at.z)
    if (dist < zones.total) want += Math.min(280, Math.max(6, vol(i) / 700))
    else if (dist < zones.heavy) want += Math.min(40, vol(i) / 3000)
  }
  const share = Math.min(1.6, budget / Math.max(want, 1))
  const count = (n: number) => Math.floor(n * share + random())
  for (let i = 0; i < info.length; i++) {
    const b = info[i]
    if (b.top <= 0) continue
    const dist = Math.hypot(b.cx - at.x, b.cz - at.z)
    if (dist > zones.light) continue
    const arrive = dist / speed(dist)
    const dir = Math.atan2(b.cz - at.z, b.cx - at.x)
    const ux = Math.cos(dir), uz = Math.sin(dir)
    if (dist < zones.vapor) {
      // blown apart where it stands: the structure shatters in a blink and the wreck drops
      const k = dist / zones.vapor
      const n = count(Math.min(280, Math.max(6, vol(i) / 700)))
      const dur = rand(0.8, 1.3)
      d.damage(i, arrive, 0.4, { shatter: 1, scorch: 1, burn: 1, ease: easeOut })
      d.damage(i, arrive + 0.08, dur, { collapse: 1, scorch: 1, burn: 1, tilt: rand(0.05, 0.2), dir, ease: fall })
      const blown = Math.floor(n * 0.65)
      for (let c = 0; c < blown; c++) {
        const a = random() * Math.PI * 2, rr = random() * b.r
        const sp = power * rand(35, 110) * (1 - 0.4 * k)
        const side = rand(-0.35, 0.35)
        d.chunk(i, b.cx + Math.cos(a) * rr, rand(b.base + 2, Math.max(b.top, 4)), b.cz + Math.sin(a) * rr,
          (ux - uz * side) * sp, rand(4, 30) * power, (uz + ux * side) * sp, arrive + rand(0, 0.3), hotDebris)
      }
      d.shed(i, arrive + 0.08, dur, fall, n - blown, at.x, at.z, 18 * power, hotDebris * 0.5)
      d.dust(i, arrive + 0.2, 1.3, [0.3, 0.28, 0.26])
      if (random() < 0.06) d.addFire(b.cx + rand(-b.r, b.r) * 0.5, 2, b.cz + rand(-b.r, b.r) * 0.5, rand(30, 80), rand(12, 18))
      crunches++
    } else if (dist < zones.total) {
      // the blast side is torn open, then the building comes down under its own weight
      const k = (dist - zones.vapor) / (zones.total - zones.vapor)
      const n = count(Math.min(280, Math.max(6, vol(i) / 700)))
      const start = arrive + rand(0.15, 0.9) + k * 0.4
      const dur = rand(1.3, 2.4) + b.top / 160
      // most come right down; some towers are left standing as gutted, broken shells
      const full = random() < (b.top > 60 ? 0.45 : 0.9) - k * 0.35
      d.damage(i, arrive, 0.5, { shatter: rand(0.4, 0.75) * (1 - k * 0.45), scorch: 0.85 - k * 0.35, burn: 0.8 - k * 0.4, tilt: rand(0.02, 0.08), dir, ease: easeOut })
      d.damage(i, start, dur, { collapse: full ? 1 : rand(0.3, 0.65), tilt: rand(0.05, 0.4) * (1 - k * 0.5), dir, ease: fall })
      const blown = Math.floor(n * 0.3)
      for (let c = 0; c < blown; c++) {
        const a = random() * Math.PI * 2, rr = random() * b.r
        const sp = power * rand(12, 45) * (1 - 0.55 * k)
        // chunks come off the face toward the blast and are flung on with it
        d.chunk(i, b.cx + Math.cos(a) * rr - ux * b.r * 0.5, rand(b.base + 2, Math.max(b.top, 4)), b.cz + Math.sin(a) * rr - uz * b.r * 0.5,
          ux * sp + rand(-5, 5), rand(2, 14), uz * sp + rand(-5, 5), arrive + rand(0, 0.35), hotDebris * 0.4)
      }
      d.shed(i, start, dur, fall, n - blown, at.x, at.z, 6 * power, hotDebris * 0.15)
      d.dust(i, start + dur * 0.5, 1.1)
      if (random() < 0.035) d.addFire(b.cx + rand(-b.r, b.r) * 0.5, rand(2, Math.max(4, b.top * 0.3)), b.cz + rand(-b.r, b.r) * 0.5, rand(25, 70), rand(7, 12))
      crunches++
    } else if (dist < zones.heavy) {
      const k = (dist - zones.total) / (zones.heavy - zones.total)
      const low = b.top < 30
      const collapse = low ? rand(0.3, 0.85) * (1 - k * 0.7) : rand(0, 0.15) * (1 - k)
      const start = arrive + rand(0.1, 0.6)
      const dur = rand(1.2, 2.4)
      d.damage(i, arrive, 0.5, { shatter: rand(0.22, 0.45) * (1 - k * 0.6), scorch: 0.5 * (1 - k), burn: 0.25 * (1 - k), ease: easeOut })
      d.damage(i, start, dur, { collapse, tilt: rand(0.03, 0.14) * (1 - k * 0.6), dir, ease: fall })
      d.shiver(i, arrive, 1)
      const n = count(Math.min(40, vol(i) / 3000))
      const blown = Math.ceil(n * 0.5)
      for (let c = 0; c < blown; c++) {
        const a = random() * Math.PI * 2, rr = random() * b.r
        const sp = power * rand(8, 25) * (1 - k * 0.6)
        d.chunk(i, b.cx + Math.cos(a) * rr - ux * b.r * 0.6, rand(b.base + 2, Math.max(b.top, 4)), b.cz + Math.sin(a) * rr - uz * b.r * 0.6,
          ux * sp + rand(-4, 4), rand(1, 8), uz * sp + rand(-4, 4), arrive + rand(0, 0.3), 0, 0.8)
      }
      if (collapse > 0.2) d.shed(i, start, dur, fall, n - blown, at.x, at.z, 3, 0)
      if (random() < 0.4) d.dust(i, arrive + 0.3, 0.75)
      crunches += low ? 1 : 0
    } else {
      const k = (dist - zones.heavy) / (zones.light - zones.heavy)
      // the odd bite out of the corners facing the blast
      d.damage(i, arrive, 0.4, { scorch: 0.18 * (1 - k), shatter: k < 0.6 && random() < 0.4 ? rand(0.16, 0.26) * (1 - k) : 0, ease: easeOut })
      d.shiver(i, arrive, 0.8)
    }
    // glass glinting as windows go
    if (dist > zones.total && random() < 0.3) for (let k = 0; k < 4; k++) e.particles.emit({ kind: Kind.Spark, x: b.cx + rand(-b.r, b.r), y: rand(4, Math.max(6, b.top)), z: b.cz + rand(-b.r, b.r), vx: ux * rand(10, 35), vy: rand(-2, 6), vz: uz * rand(10, 35), life: rand(0.6, 1.3), size0: 1.6, size1: 1, r: 0.8, g: 0.9, b: 1, gravity: 9, drag: 0.6, delay: arrive })
  }
  // landmarks
  for (const l of e.landmarks) {
    const dist = Math.hypot(l.x - at.x, l.z - at.z)
    if (dist > zones.heavy) continue
    const arrive = dist / speed(dist)
    const dir = Math.atan2(l.z - at.z, l.x - at.x)
    const start = e.time + arrive
    const tall = l.h > 200
    const target = { collapse: dist < zones.total ? (tall ? 0.35 : 0.85) : 0.15, tilt: dist < zones.total ? (tall ? 1.48 : 0.2) : 0.05, scorch: dist < zones.total ? 0.85 : 0.4 }
    landmarkAnims.push({ l, start, dir, target, dur: tall ? 4.5 : 2.5, chunks: dist < zones.total ? 1 : 0.25, shed: 0 })
    if (tall && dist < zones.total) d.e.sound.rumble(8, 0.5, arrive + 2)
  }
  e.sound.debris(Math.min(60, 10 + crunches), 4, 0.22)
}

const landmarkAnims: { l: Engine['landmarks'][number]; start: number; dir: number; target: { collapse: number; tilt: number; scorch: number }; dur: number; chunks: number; shed: number }[] = []

export function stepLandmarks(d: Disasters, t: number) {
  for (let i = landmarkAnims.length - 1; i >= 0; i--) {
    const a = landmarkAnims[i]
    const k = (t - a.start) / a.dur
    if (k < 0) continue
    const kk = clamp01(k)
    a.l.tiltDir = a.dir
    // tall towers topple with gravity (ease in), then the base crumbles
    a.l.tilt = Math.max(a.l.tilt, a.target.tilt * easeIn(kk))
    a.l.collapse = Math.max(a.l.collapse, a.target.collapse * easeInOut(clamp01((kk - 0.6) / 0.4)))
    a.l.scorch = Math.max(a.l.scorch, a.target.scorch * clamp01(kk * 4))
    // pieces break off as it goes
    const want = Math.floor(kk * 160 * a.chunks)
    for (; a.shed < want; a.shed++) {
      const h = random() * a.l.h * (a.target.tilt > 1 ? 1 - kk * 0.6 : 1)
      const tilt = a.l.tilt
      const along = Math.sin(tilt) * h, up = Math.cos(tilt) * h
      const g = rand(0.55, 0.75)
      d.e.debris.emit({ x: a.l.x + Math.cos(a.dir) * along + rand(-a.l.r, a.l.r) * 0.5, y: Math.max(3, up), z: a.l.z + Math.sin(a.dir) * along + rand(-a.l.r, a.l.r) * 0.5, vx: rand(-6, 6) + Math.cos(a.dir) * 10, vy: rand(-2, 4), vz: rand(-6, 6) + Math.sin(a.dir) * 10, sx: rand(1.5, 5), sy: rand(1, 3), sz: rand(1.5, 5), r: g, g: g * 0.98, b: g * 0.95, pile: true, life: Infinity })
    }
    if (k >= 1) {
      if (a.target.tilt > 1) {
        // the tower hits the ground: a line of dust and wreckage along where it fell
        const len = a.l.h * 0.95
        for (let s = 0; s < 40; s++) {
          const f = s / 40
          d.e.particles.emit({ kind: Kind.Dust, x: a.l.x + Math.cos(a.dir) * len * f, y: 6, z: a.l.z + Math.sin(a.dir) * len * f, vx: rand(-10, 10), vy: rand(4, 14), vz: rand(-10, 10), life: rand(10, 18), size0: 30, size1: 110, r: 0.6, g: 0.56, b: 0.5, a: 0.9, drag: 0.5, buoyancy: 0.5, turb: 8, delay: f * 0.3 })
        }
        for (let s = 0; s < 260; s++) {
          const f = random()
          const g = rand(0.5, 0.75)
          d.e.debris.emit({ x: a.l.x + Math.cos(a.dir) * len * f + rand(-8, 8), y: rand(3, 14), z: a.l.z + Math.sin(a.dir) * len * f + rand(-8, 8), vx: rand(-14, 14), vy: rand(4, 16), vz: rand(-14, 14), sx: rand(1.5, 5), sy: rand(1, 3.5), sz: rand(1.5, 5), r: g, g: g * 0.98, b: g * 0.95, pile: true, life: Infinity, delay: f * 0.3 })
        }
        d.e.rig.shake(0.35)
        d.e.sound.explosion(1500, 0.5)
      }
      landmarkAnims.splice(i, 1)
    }
  }
}

/**
 * A nuclear strike: a short flash, a dense boiling fireball that rolls up into a dark mushroom cloud, a dust wall
 * racing out along the ground, and the city coming apart behind it in chunks that pile up as rubble.
 */
class Nuke implements Event {
  done = false
  private t0: number
  private fireball: Fireball
  private slot: number
  private dustAngle = 0
  private zones: Zones
  private speed = (dist: number) => 380 + 300 / (1 + dist / 800)

  constructor(private d: Disasters, private at: THREE.Vector3, private y: number) {
    const e = d.e
    this.t0 = e.time
    this.zones = { vapor: 330 * y, total: 760 * y, heavy: 1150 * y, light: 1900 * y }
    this.fireball = new Fireball(e.scene, at, 265 * y, e.particles.uniforms, { rise: 0.9 })
    this.slot = d.impact(at.x, at.z, this.zones.total * 1.05)
    e.flash.value = 0.4
    e.flash.color.setRGB(1, 0.9, 0.75)
    e.heat.value = 0.6
    d.light.position.set(at.x, 160, at.z)
    d.light.intensity = 0
    d.light.color.setRGB(1, 0.72, 0.42)
    e.rig.shake(0.3)
    const camDist = e.rig.camera.position.distanceTo(at)
    e.sound.explosion(camDist, 1.2 * y)
    blastZones(d, at, this.zones, this.speed, y, 0.12, 50000)
    e.traffic.inCircle(at.x, at.z, this.zones.heavy, (px, pz) => {
      const dist = Math.hypot(px - at.x, pz - at.z)
      const a = Math.atan2(pz - at.z, px - at.x)
      const f = 1 - dist / this.zones.heavy
      const p = 70 * f
      const g = rand(0.12, 0.3)
      e.debris.emit({ x: px, y: 1, z: pz, vx: Math.cos(a) * p, vy: rand(6, 24) * f, vz: Math.sin(a) * p, sx: 4.4, sy: 1.5, sz: 1.9, r: g, g, b: g * 1.05, delay: dist / this.speed(dist), pile: true, life: Infinity, hot: dist < this.zones.vapor ? 1 : 0 })
    })
    // frame the event: pull back far enough to see the cloud rise, but keep the ruins readable
    const r = e.rig
    const focusDist = Math.hypot(r.cur.x - at.x, r.cur.z - at.z)
    if (r.cur.distance < 2600 || focusDist > 2200) {
      r.flyTo({ x: THREE.MathUtils.lerp(r.cur.x, at.x, 0.6), z: THREE.MathUtils.lerp(r.cur.z, at.z, 0.6), distance: Math.max(r.cur.distance, 3000 * y), pitch: Math.min(Math.max(r.cur.pitch, 0.22), 0.34) }, 3)
    }
  }

  update(dt: number, t: number) {
    const e = this.d.e
    const age = t - this.t0
    stepLandmarks(this.d, t)
    // the shock front: integrate the distance travelled at the (slowing) shock speed
    let r = 0
    const steps = 24
    for (let i = 0; i < steps; i++) r += this.speed(r) * (age / steps)
    // the dust wall: the ground itself thrown up along the front, low, dense and dark
    if (r < this.zones.heavy * 1.1 && age > 0.05) {
      const circ = Math.PI * 2 * r
      const n = Math.min(160, Math.floor(circ / 45 * dt * 5))
      const strength = 1 - r / (this.zones.heavy * 1.1)
      for (let i = 0; i < n; i++) {
        this.dustAngle += 2.39996
        const a = this.dustAngle + rand(-0.05, 0.05)
        const x = this.at.x + Math.cos(a) * r, z = this.at.z + Math.sin(a) * r
        if (this.d.mask.isWater(x, z)) {
          e.particles.emit({ kind: Kind.Spray, x, y: 2, z, vx: Math.cos(a) * 60 * strength, vy: rand(10, 30) * strength, vz: Math.sin(a) * 60 * strength, life: rand(2, 4), size0: 20, size1: 70, r: 0.85, g: 0.9, b: 0.95, a: 0.5 * strength, drag: 1.1, gravity: 6, turb: 4 })
          continue
        }
        const s = rand(50, 90) * (0.5 + strength)
        const tone = rand(0.5, 0.66) - (1 - strength) * 0.12
        const sp = this.speed(r) * rand(0.2, 0.34)
        e.particles.emit({ kind: Kind.Dust, x, y: rand(1, 8), z, vx: Math.cos(a) * sp, vy: rand(3, 14) * strength, vz: Math.sin(a) * sp, life: rand(2.5, 4.5), size0: s * 0.45, size1: s * 1.7, r: tone, g: tone * 0.94, b: tone * 0.86, a: 0.8 * Math.sqrt(strength), drag: 1.3, buoyancy: 0.15, turb: 8 })
        // grit and gravel in it
        if (i % 8 === 0 && strength > 0.2) {
          const g = rand(0.25, 0.45)
          e.debris.emit({ x, y: 1, z, vx: Math.cos(a) * sp * 0.5, vy: rand(4, 14) * strength, vz: Math.sin(a) * sp * 0.5, sx: rand(0.5, 1.4), sy: rand(0.4, 1), sz: rand(0.5, 1.4), r: g, g: g * 0.96, b: g * 0.9, life: rand(5, 9) })
        }
      }
    }
    // camera shake when the front passes under the camera's focus
    const camR = Math.hypot(e.rig.cur.x - this.at.x, e.rig.cur.z - this.at.z)
    if (Math.abs(r - camR) < this.speed(r) * dt * 1.5) e.rig.shake(0.9 * Math.max(0.25, 1 - camR / this.zones.light))
    // scorch spreads, crater glows then cools
    const u = e.ground
    u.uImpacts.value[this.slot].w = Math.min(1, age / 1.2)
    u.uImpactGlow.value[this.slot] = Math.max(0, 1 - age / 50) * Math.min(1, age * 2)
    // fireball and light
    this.fireball.update(age, dt)
    const fp = this.fireball.mesh.position
    this.d.light.position.copy(fp)
    // physical point light: a blinding instant, then the fireball's orange glow lighting the city and the cloud
    this.d.light.intensity = this.y * (7e5 * Math.exp(-age * 2.2) * Math.min(1, age * 20 + 0.3) + 2.5e5 * Math.exp(-age / 9))
    const pl = e.particles.uniforms
    pl.uLightPos.value[0].set(fp.x, fp.y, fp.z, Math.max(0, 700 * this.y * (1 - age / 25)))
    pl.uLightColor.value[0].setRGB(1.5, 0.62, 0.25).multiplyScalar(age < 1 ? 2.2 : 0.9 * Math.exp(-(age - 1) / 5))
    const du = e.debris.uniforms
    du.uFire.value.set(fp.x, fp.y, fp.z, Math.max(0, 900 * this.y * (1 - age / 30)))
    du.uFireColor.value.setRGB(1.4, 0.55, 0.2).multiplyScalar(age < 1 ? 3 : 2.5 * Math.exp(-(age - 1) / 6))
    mushroom(e, this.at, this.fireball, age, dt, this.y)
    if (age > 78) this.dispose()
  }

  dispose() {
    if (this.done) return
    this.done = true
    this.fireball.dispose()
    this.d.e.particles.uniforms.uLightPos.value[0].w = 0
    this.d.e.debris.uniforms.uFire.value.w = 0
  }
}

/**
 * The particle half of the mushroom cloud, shared by the nuke and (smaller) the meteor: soft smoke wrapping the
 * opaque puffs of the cap and stem, hot smoke boiling off the fireball, and the base surge, a low ring of dust that
 * rolls out from the stem's foot and darkens to ash.
 */
function mushroom(e: Engine, at: THREE.Vector3, fireball: Fireball, age: number, dt: number, y: number, scale = 1) {
  const capY = fireball.mesh.position.y
  const R = fireball.radius()
  const k = y * scale
  // cap wisps: darker smoke circling the rising torus, glowing inside while young
  if (age > 1.5 && age < 30) {
    const n = Math.floor(dt * (age < 6 ? 50 : 20) * scale)
    for (let i = 0; i < n; i++) {
      const heat = Math.max(0, 1 - age / 7) * rand(0.5, 1)
      const tone = rand(0.22, 0.36)
      e.particles.emit({
        kind: Kind.Smoke, x: at.x, y: capY - 60 * k, z: at.z, life: rand(55, 75),
        size0: rand(120, 180) * k, size1: rand(300, 420) * k,
        r: tone, g: tone * 0.95, b: tone * 0.9, a: 0.75, heat,
        orbit: [random() * Math.PI * 2, rand(260, 360) * k, random() * Math.PI * 2], rise: 70 * k,
      })
    }
  }
  // stem: dark churning smoke and dust sucked up into the cap
  if (age > 1.2 && age < 40) {
    const n = Math.floor(dt * 40 * scale)
    for (let i = 0; i < n; i++) {
      const h = random() ** 0.8 * capY * 0.85
      const f = Math.min(1, h / Math.max(capY, 1))
      const narrow = (50 + 70 * f * f * f + 60 * (1 - f) ** 6) * k
      const a = random() * Math.PI * 2, rr = Math.sqrt(random()) * narrow
      const tone = rand(0.16, 0.3)
      e.particles.emit({
        kind: Kind.Smoke, x: at.x + Math.cos(a) * rr, y: h, z: at.z + Math.sin(a) * rr,
        vx: -Math.sin(a) * 10, vy: rand(30, 50) * k, vz: Math.cos(a) * 10, life: rand(22, 34),
        size0: rand(70, 105) * k, size1: rand(150, 220) * k, r: tone, g: tone * 0.95, b: tone * 0.9, a: 0.8,
        drag: 0.4, buoyancy: 1.5, turb: 9, heat: age < 4 && f < 0.3 ? 0.5 : 0,
      })
    }
  }
  // base surge: a low rolling ring of dust out from the stem's foot, lighter at first, then ash
  if (age > 0.3 && age < 7) {
    const n = Math.floor(dt * 110 * scale)
    const ash = clamp01((age - 1.5) / 4)
    for (let i = 0; i < n; i++) {
      const a = random() * Math.PI * 2
      const tone = rand(0.52, 0.62) - ash * 0.14
      e.particles.emit({
        kind: Kind.Dust, x: at.x + Math.cos(a) * 140 * k, y: rand(4, 14), z: at.z + Math.sin(a) * 140 * k,
        vx: Math.cos(a) * rand(100, 190) * k, vy: rand(2, 8), vz: Math.sin(a) * rand(100, 190) * k, life: rand(12, 18),
        size0: 70 * k, size1: rand(200, 280) * k, r: tone, g: tone * 0.9, b: tone * 0.8, a: 0.85, drag: 0.4, buoyancy: 0.25, turb: 12,
      })
    }
  }
  // hot smoke boiling off the fireball's surface
  if (age > 0.6 && age < 6) {
    const n = Math.floor(dt * 110 * scale)
    const c = fireball.mesh.position
    for (let i = 0; i < n; i++) {
      const v = randomDir()
      v.y = Math.abs(v.y) * 0.8 + 0.1
      const tone = rand(0.2, 0.32)
      e.particles.emit({
        kind: Kind.Smoke, x: c.x + v.x * R * 1.0, y: c.y + v.y * R * 0.9, z: c.z + v.z * R * 1.0,
        vx: v.x * 16, vy: rand(25, 45) * k, vz: v.z * 16, life: rand(30, 45),
        size0: R * rand(0.35, 0.55), size1: R * rand(0.9, 1.3), r: tone, g: tone * 0.93, b: tone * 0.88, a: 0.95, drag: 0.5, buoyancy: 1.2, turb: 10,
        heat: Math.max(0, 1 - age / 5) * rand(0.6, 1),
      })
    }
  }
}

/** A meteor: a burning streak out of the sky, a crater, ejecta and a smaller shockwave. */
class Meteor implements Event {
  done = false
  private t0: number
  private from: THREE.Vector3
  private head: THREE.Group
  private plasma: THREE.Mesh
  private plasmaMat: THREE.ShaderMaterial
  private hit = false
  private dur = 2.4
  private fireball: Fireball | null = null
  private slot = -1
  private zones = { vapor: 150, total: 360, heavy: 600, light: 950 }
  private speed = (dist: number) => 320 + 160 / (1 + dist / 400)
  private hitT = 0

  constructor(private d: Disasters, private at: THREE.Vector3) {
    const e = d.e
    this.t0 = e.time
    // come in across the view, from one side and high up, so the streak crosses the frame
    const cam = e.rig.camera.position
    const a = Math.atan2(cam.z - at.z, cam.x - at.x) + (random() < 0.5 ? -1 : 1) * rand(1.1, 1.5)
    this.from = new THREE.Vector3(at.x + Math.cos(a) * 4600, 3800, at.z + Math.sin(a) * 4600)
    // the head: a white-hot core in an orange glow
    this.head = new THREE.Group()
    this.head.add(new THREE.Mesh(new THREE.IcosahedronGeometry(16, 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 7.5, 5), toneMapped: false })))
    // the plasma sheath: a long cone behind the head, white at the nose, burning to orange and nothing at the tail
    this.plasmaMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vT;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vT = 1.0 - uv.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying float vT;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
          float flick = 0.85 + 0.15 * sin(vT * 40.0 - uTime * 30.0);
          vec3 hot = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.45, 0.08), smoothstep(0.0, 0.35, vT));
          hot = mix(hot, vec3(0.6, 0.1, 0.02), smoothstep(0.35, 1.0, vT));
          float a = (1.0 - smoothstep(0.0, 1.0, vT)) * edge * flick;
          gl_FragColor = vec4(hot * a * 5.0, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    const cone = new THREE.CylinderGeometry(0, 26, 520, 24, 1, true)
    cone.translate(0, -260, 0)
    this.plasma = new THREE.Mesh(cone, this.plasmaMat)
    this.head.add(this.plasma)
    this.head.position.copy(this.from)
    e.scene.add(this.head)
    e.sound.whoosh(this.dur)
    d.light.color.setRGB(1, 0.62, 0.32)
  }

  update(dt: number, t: number) {
    const e = this.d.e
    const age = t - this.t0
    stepLandmarks(this.d, t)
    if (!this.hit) {
      const k = Math.min(1, age / this.dur)
      const p = new THREE.Vector3().lerpVectors(this.from, this.at, k * k * 0.3 + k * 0.7)
      const prev = this.head.position.clone()
      this.head.position.copy(p)
      // point the plasma cone back along the path
      const dir = p.clone().sub(prev)
      if (dir.lengthSq() > 1e-6) this.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
      this.plasmaMat.uniforms.uTime.value = age
      this.d.light.position.copy(p)
      this.d.light.intensity = 2.5e5 * (0.3 + k)
      // a dense smoke trail and shed embers; emission follows the distance covered
      const n = Math.min(240, Math.floor(dir.length() / 3))
      for (let i = 0; i < n; i++) {
        const q = prev.clone().addScaledVector(dir, random())
        e.particles.emit({ kind: Kind.Smoke, x: q.x + rand(-10, 10), y: q.y + rand(-10, 10), z: q.z + rand(-10, 10), vx: rand(-9, 9), vy: rand(-3, 7), vz: rand(-9, 9), life: rand(6, 11), size0: rand(18, 34), size1: rand(90, 170), r: 0.56, g: 0.54, b: 0.52, a: 0.6, drag: 0.7, buoyancy: 0.6, turb: 26, heat: 0.3 })
        if (i % 10 === 0) e.particles.emit({ kind: Kind.Fire, x: q.x + rand(-6, 6), y: q.y + rand(-6, 6), z: q.z + rand(-6, 6), vx: rand(-8, 8), vy: rand(-8, 8), vz: rand(-8, 8), life: rand(0.3, 0.7), size0: 46, size1: 12, r: 0.9, g: 0.9, b: 0.9, drag: 1.5 })
        if (i % 24 === 0) e.particles.emit({ kind: Kind.Spark, x: q.x, y: q.y, z: q.z, vx: rand(-50, 50), vy: rand(-50, 20), vz: rand(-50, 50), life: rand(0.5, 1.2), size0: 4, size1: 2, r: 1, g: 0.8, b: 0.5, gravity: 30, drag: 0.4 })
      }
      if (k >= 1) this.impact()
      return
    }
    const since = t - this.hitT
    let r = 0
    for (let i = 0; i < 16; i++) r += this.speed(r) * (since / 16)
    const u = e.ground
    u.uImpacts.value[this.slot].w = Math.min(1, since / 0.6)
    u.uImpactGlow.value[this.slot] = Math.max(0, 1.2 - since / 25)
    const camR = Math.hypot(e.rig.cur.x - this.at.x, e.rig.cur.z - this.at.z)
    if (Math.abs(r - camR) < this.speed(r) * dt * 1.5) e.rig.shake(0.6 * Math.max(0.2, 1 - camR / this.zones.light))
    if (this.fireball) {
      this.fireball.update(since * 1.5, dt)
      this.d.light.position.copy(this.fireball.mesh.position)
      this.d.light.intensity = since < 0.1 ? 1.2e5 : 1.2e5 * Math.exp(-(since - 0.1) * 3) + 4e4 * Math.exp(-since / 6)
      const pl = e.particles.uniforms
      pl.uLightPos.value[1].set(this.fireball.mesh.position.x, this.fireball.mesh.position.y, this.fireball.mesh.position.z, Math.max(0, 380 * (1 - since / 18)))
      pl.uLightColor.value[1].setRGB(1.5, 0.6, 0.24).multiplyScalar(since < 0.8 ? 2 : Math.exp(-(since - 0.8) / 4))
      const fp = this.fireball.mesh.position
      const du = e.debris.uniforms
      du.uFire.value.set(fp.x, fp.y, fp.z, Math.max(0, 420 * (1 - since / 20)))
      du.uFireColor.value.setRGB(1.4, 0.55, 0.2).multiplyScalar(since < 0.6 ? 3 : 2.5 * Math.exp(-(since - 0.6) / 4))
      // a smaller mushroom over the crater
      mushroom(e, this.at, this.fireball, since * 1.5, dt, 1, 0.55)
    }
    if (since > 45) this.dispose()
  }

  dispose() {
    if (this.done) return
    this.done = true
    const e = this.d.e
    if (!this.hit) { e.scene.remove(this.head); this.plasmaMat.dispose() }
    e.debris.uniforms.uFire.value.w = 0
    this.fireball?.dispose()
    e.particles.uniforms.uLightPos.value[1].w = 0
  }

  private impact() {
    const e = this.d.e
    const at = this.at
    this.hit = true
    this.hitT = e.time
    e.scene.remove(this.head)
    this.head.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose() })
    this.plasmaMat.dispose()
    this.fireball = new Fireball(e.scene, at, 150, e.particles.uniforms, { rise: 0.75, fade: [26, 44] })
    this.slot = this.d.impact(at.x, at.z, 320)
    e.flash.value = 0.35
    e.flash.color.setRGB(1, 0.82, 0.6)
    e.heat.value = 0.25
    e.rig.shake(0.8)
    e.sound.explosion(e.rig.camera.position.distanceTo(at), 0.95)
    blastZones(this.d, at, this.zones, this.speed, 0.9, 0.8, 26000)
    e.traffic.inCircle(at.x, at.z, this.zones.heavy, () => {})
    // the ejecta crown: molten chunks thrown up and out in a cone, glowing as they fly
    for (let i = 0; i < 2200; i++) {
      const a = random() * Math.PI * 2
      const up = rand(0.45, 1.2)
      const sp = rand(30, 120) * Math.sqrt(random() * 0.8 + 0.2)
      const s = 1.2 + 5.5 * random() ** 2
      const grey = rand(0.2, 0.42)
      e.debris.emit({ x: at.x + rand(-30, 30), y: rand(4, 20), z: at.z + rand(-30, 30), vx: Math.cos(a) * sp, vy: sp * up, vz: Math.sin(a) * sp, sx: s * rand(0.7, 1.3), sy: s * rand(0.5, 1), sz: s * rand(0.7, 1.3), r: grey, g: grey * 0.95, b: grey * 0.9, hot: random() < 0.35 ? 1 : 0, pile: true, life: Infinity, delay: rand(0, 0.15) })
    }
    for (let i = 0; i < 220; i++) {
      const v = randomDir()
      v.y = Math.abs(v.y) * 1.3 + 0.2
      e.particles.emit({ kind: Kind.Spark, x: at.x, y: 10, z: at.z, vx: v.x * rand(50, 170), vy: v.y * rand(50, 160), vz: v.z * rand(50, 170), life: rand(1, 2.6), size0: 4, size1: 2, r: 0.7, g: 0.5, b: 0.25, gravity: 30, drag: 0.3 })
    }
    // the bam: a burst of light at the crater, then a dome of fire thrown up and out of it
    // a brief hot core of light (small: a big soft glow would read as a dome)
    for (let i = 0; i < 2; i++) e.particles.emit({ kind: Kind.Glow, x: at.x, y: 25 + i * 20, z: at.z, life: rand(0.18, 0.3), size0: rand(120, 160), size1: rand(200, 260), r: 1.6, g: 1.1, b: 0.65 })
    for (let i = 0; i < 110; i++) {
      const v = randomDir()
      v.y = Math.abs(v.y) * 0.9 + 0.15
      const sp = rand(30, 120)
      e.particles.emit({ kind: Kind.Fire, x: at.x + v.x * 20, y: 15 + v.y * 20, z: at.z + v.z * 20, vx: v.x * sp, vy: v.y * sp, vz: v.z * sp, life: rand(0.9, 1.9), size0: rand(60, 110), size1: rand(25, 45), r: 0.42, g: 0.38, b: 0.35, drag: 2.2, buoyancy: 8, turb: 10 })
    }
    // a ring of dust kicked out low around the crater
    for (let i = 0; i < 260; i++) {
      const a = random() * Math.PI * 2
      e.particles.emit({ kind: Kind.Dust, x: at.x + Math.cos(a) * 60, y: 6, z: at.z + Math.sin(a) * 60, vx: Math.cos(a) * rand(90, 170), vy: rand(4, 18), vz: Math.sin(a) * rand(90, 170), life: rand(6, 10), size0: 40, size1: 150, r: 0.62, g: 0.58, b: 0.52, a: 0.9, drag: 0.7, buoyancy: 0.2, turb: 10 })
    }
    for (let i = 0; i < 40; i++) this.d.addFire(at.x + rand(-260, 260), 2, at.z + rand(-260, 260), rand(25, 60), rand(9, 15))
  }
}
