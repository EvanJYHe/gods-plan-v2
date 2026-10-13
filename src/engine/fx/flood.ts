/**
 * A shallow-water simulation on a square height-field grid (water depth per cell, velocities on the cell faces), solved
 * on the CPU (in a worker in real time, see floodWorker.ts): semi-Lagrangian momentum advection, the pressure gradient of the free surface, bed friction
 * and an upwind, mass-conserving depth update that handles wet/dry fronts. Buildings are part of the bed, so water runs
 * down the streets, piles against facades and pours over low roofs; a foam field rides the flow. floodSurface.ts draws it.
 */

/** Below this depth a cell counts as dry. */
export const DRY = 0.02

function hash(x: number, y: number, s: number) {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453
  return v - Math.floor(v)
}
/** Smooth 2D value noise 0..1. */
function vnoise(x: number, y: number, s: number) {
  const i = Math.floor(x), j = Math.floor(y), a = x - i, b = y - j
  const u = a * a * (3 - 2 * a), v = b * b * (3 - 2 * b)
  return (hash(i, j, s) * (1 - u) + hash(i + 1, j, s) * u) * (1 - v) + (hash(i, j + 1, s) * (1 - u) + hash(i + 1, j + 1, s) * u) * v
}

export class Flood {
  readonly n: number
  readonly cell: number
  readonly x0: number
  readonly z0: number
  /** gravity (cinema scale: a faster, more violent flow than real gravity would give at this size) */
  g = 100
  /** bed elevation (lake bottom < 0, ground, building roofs) */
  readonly b: Float32Array
  /** water depth */
  h: Float32Array
  /** x velocity on the face left of cell (i, j): u[j * (n + 1) + i] */
  u: Float32Array
  /** z velocity on the face above cell (i, j): v[j * n + i] */
  v: Float32Array
  foam: Float32Array
  /** deepest water seen per cell (for wetness) */
  maxH: Float32Array
  /** building index per cell, -1 for none, -2 for unbreakable landmarks */
  readonly bid: Int32Array
  /** 1 where the cell started as land */
  readonly land: Uint8Array
  /** distance to the shoreline in metres (both sides) */
  readonly shore: Float32Array
  /** resting depth of lake cells (0 on land) */
  readonly rest: Float32Array
  private tu: Float32Array
  private tv: Float32Array
  private tf: Float32Array
  private fu: Float32Array
  private fv: Float32Array
  /** active cell rectangle (inclusive): everything outside it is at rest */
  i0 = 0; i1 = -1; j0 = 0; j1 = -1
  /** drainage on land (m/s), pull of the lake on standing water (fake slope), relax the lake to rest (0..1) */
  drain = 0
  slope = 0
  calm = 0
  /** surge driven in through the south edge: extra surface height and its northward (-z) speed */
  inflow = 0
  inflowV = 0
  /** how strongly the surge comes in along the south edge, per column */
  readonly inflowVar: Float32Array
  /** foam generated this step where water slams into walls (cell index -> strength), read by the caller */
  time = 0
  private sponge: Float32Array
  /** fields a worker sends back each step */
  static readonly LIVE = ['h', 'u', 'v', 'foam', 'maxH'] as const

  constructor(n: number, cell: number, x0: number, z0: number) {
    this.n = n; this.cell = cell; this.x0 = x0; this.z0 = z0
    const N = n * n
    this.b = new Float32Array(N)
    this.h = new Float32Array(N)
    this.foam = new Float32Array(N)
    this.tf = new Float32Array(N)
    this.maxH = new Float32Array(N)
    this.bid = new Int32Array(N).fill(-1)
    this.land = new Uint8Array(N)
    this.shore = new Float32Array(N)
    this.rest = new Float32Array(N)
    this.inflowVar = new Float32Array(n).fill(1)
    this.u = new Float32Array((n + 1) * n)
    this.tu = new Float32Array((n + 1) * n)
    this.fu = new Float32Array((n + 1) * n)
    this.v = new Float32Array(n * (n + 1))
    this.tv = new Float32Array(n * (n + 1))
    this.fv = new Float32Array(n * (n + 1))
    // absorbing layer around the edges: 0 inside, rising toward 1 at the border
    this.sponge = new Float32Array(N)
    const M = 28
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const d = Math.min(i, j, n - 1 - i, n - 1 - j)
      this.sponge[j * n + i] = d < M ? (1 - d / M) ** 2 : 0
    }
  }

  /** Scene x/z of the centre of cell (i, j). */
  cx(i: number) { return this.x0 + (i + 0.5) * this.cell }
  cz(j: number) { return this.z0 + (j + 0.5) * this.cell }

  /** Lake/land setup from a water test: lake bottom deepens away from the shore, land is flat. */
  terrain(isWater: (x: number, z: number) => boolean, seed = 0) {
    const { n, cell } = this
    const N = n * n
    const wet = new Uint8Array(N)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) wet[j * n + i] = isWater(this.cx(i), this.cz(j)) ? 1 : 0
    // chamfer distance to the other kind of cell
    const d = this.shore
    const INF = 1e9
    for (let k = 0; k < N; k++) {
      const i = k % n, j = (k / n) | 0
      const w = wet[k]
      const edge = (i > 0 && wet[k - 1] !== w) || (i < n - 1 && wet[k + 1] !== w) || (j > 0 && wet[k - n] !== w) || (j < n - 1 && wet[k + n] !== w)
      d[k] = edge ? 0.5 : INF
    }
    const D = 1.4142
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i
      let m = d[k]
      if (i > 0) m = Math.min(m, d[k - 1] + 1)
      if (j > 0) { m = Math.min(m, d[k - n] + 1); if (i > 0) m = Math.min(m, d[k - n - 1] + D); if (i < n - 1) m = Math.min(m, d[k - n + 1] + D) }
      d[k] = m
    }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i
      let m = d[k]
      if (i < n - 1) m = Math.min(m, d[k + 1] + 1)
      if (j < n - 1) { m = Math.min(m, d[k + n] + 1); if (i < n - 1) m = Math.min(m, d[k + n + 1] + D); if (i > 0) m = Math.min(m, d[k + n - 1] + D) }
      d[k] = m
    }
    for (let k = 0; k < N; k++) {
      d[k] = Math.min(d[k], 1e5) * cell
      if (wet[k]) {
        // shoals and channels on the lake bottom: the wave runs faster over deep water, so its front breaks up
        const i = k % n, j = (k / n) | 0
        const rough = 1 + Math.min(1, d[k] / 150) * (0.55 * (vnoise(i * cell / 230, j * cell / 230, seed) * 2 - 1) + 0.3 * (vnoise(i * cell / 110, j * cell / 110, seed + 7) * 2 - 1))
        this.b[k] = -(3 + 52 * (1 - Math.exp(-d[k] / 450))) * rough
        this.h[k] = this.rest[k] = -this.b[k]
        this.land[k] = 0
      } else {
        this.b[k] = 0.3
        this.h[k] = this.rest[k] = 0
        this.land[k] = 1
      }
    }
  }

  /** Mark an obstacle cell: the bed rises to the roof. */
  obstacle(k: number, top: number, id: number) {
    const y = 0.3 + top
    if (y > this.b[k]) { this.b[k] = y; this.bid[k] = id; this.h[k] = 0; this.rest[k] = 0 }
  }

  /** Grow the active rectangle to include a cell range. */
  wake(i0: number, i1: number, j0: number, j1: number) {
    if (this.i1 < this.i0) { this.i0 = i0; this.i1 = i1; this.j0 = j0; this.j1 = j1 }
    else { this.i0 = Math.min(this.i0, i0); this.i1 = Math.max(this.i1, i1); this.j0 = Math.min(this.j0, j0); this.j1 = Math.max(this.j1, j1) }
    const n = this.n
    this.i0 = Math.max(0, this.i0); this.j0 = Math.max(0, this.j0); this.i1 = Math.min(n - 1, this.i1); this.j1 = Math.min(n - 1, this.j1)
  }

  step(dt: number) {
    if (this.i1 < this.i0) return
    this.time += dt
    const n = this.n, n1 = n + 1
    const h = this.h, b = this.b, land = this.land, sh = this.shore, rest = this.rest, sponge = this.sponge, maxH = this.maxH
    const u = this.u, v = this.v, nu = this.tu, nv = this.tv, fu = this.fu, fv = this.fv
    // work two cells beyond the active area so it can spread
    const I0 = Math.max(0, this.i0 - 2), I1 = Math.min(n - 1, this.i1 + 2)
    const J0 = Math.max(0, this.j0 - 2), J1 = Math.min(n - 1, this.j1 + 2)
    const dx = this.cell, k = dt / dx, gk = this.g * k
    const vmax = 0.24 * dx / dt
    const slope = this.slope * this.g * dt / dx
    const fr = 0.004 * dt, thin = 0.6 * dt
    const nmax = n - 1, nmin2 = n - 2

    // 1. x faces: advect (semi-Lagrangian), surface slope, friction, walls; then the upwind flux
    const ui0 = Math.max(1, I0), ui1 = Math.min(n - 1, I1 + 1)
    for (let j = J0; j <= J1; j++) {
      const row = j * n, frow = j * n1
      for (let i = ui0; i <= ui1; i++) {
        const L = row + i - 1, R = L + 1, f = frow + i
        const hL = h[L], hR = h[R]
        if (hL <= DRY && hR <= DRY) { nu[f] = 0; fu[f] = 0; continue }
        const bL = b[L], bR = b[R], eL = bL + hL, eR = bR + hR
        if ((hL <= DRY && bL >= eR) || (hR <= DRY && bR >= eL)) { nu[f] = 0; fu[f] = 0; continue }
        let w = u[f]
        const vv = 0.25 * (v[L] + v[R] + v[L + n] + v[R + n])
        if (w * w + vv * vv > 1e-6) {
          // back-trace from the face at (i, j + 0.5); u lives at (i, j + 0.5)
          let x = i - w * k, z = j - vv * k
          if (x < 0) x = 0; else if (x > nmax) x = nmax
          if (z < 0) z = 0; else if (z > nmin2) z = nmin2
          const xi = x | 0, zi = z | 0, ax = x - xi, az = z - zi
          const p = zi * n1 + xi
          w = (u[p] + (u[p + 1] - u[p]) * ax) * (1 - az) + (u[p + n1] + (u[p + n1 + 1] - u[p + n1]) * ax) * az
        }
        w -= gk * (eR - eL)
        // the lake's pull on water standing on land (Toronto slopes down to the lake)
        if (slope > 0 && land[L] === 1 && land[R] === 1) w -= slope * (sh[R] - sh[L])
        const hf = 0.5 * (hL + hR)
        w /= 1 + fr * (w < 0 ? -w : w) / (hf > 0.05 ? hf : 0.05) + (hf < 0.5 ? thin : 0)
        if (w > vmax) w = vmax; else if (w < -vmax) w = -vmax
        nu[f] = w
        const top = bL > bR ? bL : bR
        const d = w > 0 ? eL - top : eR - top
        fu[f] = d > 0 ? w * d : 0
      }
    }
    // 2. z faces
    const vj0 = Math.max(1, J0), vj1 = Math.min(n - 1, J1 + 1)
    for (let j = vj0; j <= vj1; j++) {
      const row = j * n, urow = (j - 1) * n1
      for (let i = I0; i <= I1; i++) {
        const D = row + i, U = D - n
        const hU = h[U], hD = h[D]
        if (hU <= DRY && hD <= DRY) { nv[D] = 0; fv[D] = 0; continue }
        const bU = b[U], bD = b[D], eU = bU + hU, eD = bD + hD
        if ((hU <= DRY && bU >= eD) || (hD <= DRY && bD >= eU)) { nv[D] = 0; fv[D] = 0; continue }
        let w = v[D]
        const q = urow + i
        const uu = 0.25 * (u[q] + u[q + 1] + u[q + n1] + u[q + n1 + 1])
        if (w * w + uu * uu > 1e-6) {
          // v lives at (i + 0.5, j)
          let x = i - uu * k, z = j - w * k
          if (x < 0) x = 0; else if (x > nmin2) x = nmin2
          if (z < 0) z = 0; else if (z > nmax) z = nmax
          const xi = x | 0, zi = z | 0, ax = x - xi, az = z - zi
          const p = zi * n + xi
          w = (v[p] + (v[p + 1] - v[p]) * ax) * (1 - az) + (v[p + n] + (v[p + n + 1] - v[p + n]) * ax) * az
        }
        w -= gk * (eD - eU)
        if (slope > 0 && land[U] === 1 && land[D] === 1) w -= slope * (sh[D] - sh[U])
        const hf = 0.5 * (hU + hD)
        w /= 1 + fr * (w < 0 ? -w : w) / (hf > 0.05 ? hf : 0.05) + (hf < 0.5 ? thin : 0)
        if (w > vmax) w = vmax; else if (w < -vmax) w = -vmax
        nv[D] = w
        const top = bU > bD ? bU : bD
        const d = w > 0 ? eU - top : eD - top
        fv[D] = d > 0 ? w * d : 0
      }
    }
    for (let j = J0; j <= J1; j++) u.set(nu.subarray(j * n1 + ui0, j * n1 + ui1 + 1), j * n1 + ui0)
    for (let j = vj0; j <= vj1; j++) v.set(nv.subarray(j * n + I0, j * n + I1 + 1), j * n + I0)

    // 3. depth update, edges, drainage; and find the new active area
    let ni0 = n, ni1 = -1, nj0 = n, nj1 = -1
    const drain = this.drain * dt, calm = this.calm * dt, spk = dt * 2.5, evap = 0.03 * dt
    const jIn = n - 28, inflow = this.inflow, inflowV = this.inflowV
    for (let j = J0; j <= J1; j++) {
      const row = j * n, frow = j * n1
      const driven = j >= jIn && inflow > 0.01
      for (let i = I0; i <= I1; i++) {
        const c = row + i, f = frow + i
        let hh = h[c] - k * (fu[f + 1] - fu[f] + fv[c + n] - fv[c])
        if (hh < 0) hh = 0
        const sp = sponge[c]
        if (sp > 0 || calm > 0) {
          let a = sp * spk
          if (calm > a) a = calm
          if (a > 1) a = 1
          if (driven && land[c] === 0) {
            // the open lake beyond the grid keeps pushing water in (fading toward the side edges)
            const side = Math.min(i, n - 1 - i) / 120
            const w = (side < 1 ? side : 1) * this.inflowVar[i]
            hh += (rest[c] + inflow * w - hh) * a
            u[f] *= 1 - a; v[c] += (-inflowV * w - v[c]) * a
          } else {
            hh += (rest[c] - hh) * a
            u[f] *= 1 - a; v[c] *= 1 - a
          }
        }
        if (land[c] === 1 && hh > 0) {
          hh -= drain + (hh < 0.15 ? evap : 0)
          if (hh < 0) hh = 0
          if (hh > maxH[c]) maxH[c] = hh
        }
        h[c] = hh
        const uf = u[f], vc = v[c], dr = hh - rest[c]
        if (uf > 0.02 || uf < -0.02 || vc > 0.02 || vc < -0.02 || dr > 0.005 || dr < -0.005) {
          if (i < ni0) ni0 = i
          if (i > ni1) ni1 = i
          if (j < nj0) nj0 = j
          nj1 = j
        }
      }
    }
    if (ni1 >= ni0) { this.i0 = ni0; this.i1 = ni1; this.j0 = nj0; this.j1 = nj1 } else { this.i1 = -1; this.i0 = 0 }
  }

  /** Foam (once a frame): carried by the flow, made where it runs fast, converges, breaks or slams into walls; it fades. */
  foamStep(dt: number) {
    if (this.i1 < this.i0) return
    const n = this.n, n1 = n + 1, h = this.h, b = this.b, u = this.u, v = this.v, foam = this.foam, tf = this.tf, land = this.land
    const I0 = Math.max(1, this.i0 - 2), I1 = Math.min(n - 2, this.i1 + 2)
    const J0 = Math.max(1, this.j0 - 2), J1 = Math.min(n - 2, this.j1 + 2)
    const dx = this.cell, k = dt / dx, lim = n - 1.001
    const decL = Math.exp(-dt * 0.24), decW = Math.exp(-dt * 0.12)
    for (let j = J0; j <= J1; j++) {
      const row = j * n, frow = j * n1
      for (let i = I0; i <= I1; i++) {
        const c = row + i
        const hh = h[c]
        if (hh <= DRY) { tf[c] = 0; continue }
        const ul = u[frow + i], ur = u[frow + i + 1], vu = v[c], vd = v[c + n]
        const uc = 0.5 * (ul + ur), vc = 0.5 * (vu + vd)
        const sp2 = uc * uc + vc * vc
        let fo = foam[c]
        if (sp2 > 1e-4) {
          let x = i - uc * k, z = j - vc * k
          if (x < 0) x = 0; else if (x > lim) x = lim
          if (z < 0) z = 0; else if (z > lim) z = lim
          const xi = x | 0, zi = z | 0, ax = x - xi, az = z - zi
          const p = zi * n + xi
          fo = (foam[p] + (foam[p + 1] - foam[p]) * ax) * (1 - az) + (foam[p + n] + (foam[p + n + 1] - foam[p + n]) * ax) * az
        }
        let src = 0
        // turbulent (supercritical) flow churns white: Froude number over ~0.9
        const fr2 = sp2 / (this.g * hh + 1e-3)
        if (fr2 > 0.8) src += (Math.sqrt(fr2) - 0.9) * 2.2
        const div = (ur - ul + vd - vu) / dx
        if (div < -0.12) src -= (div + 0.12) * 4
        if (hh < 1.2 && sp2 > 4) src += 0.6
        const e = b[c] + hh
        const hl = h[c - 1], hr = h[c + 1], hu = h[c - n], hd = h[c + n]
        const el = hl > DRY ? b[c - 1] + hl : e, er = hr > DRY ? b[c + 1] + hr : e
        const eu = hu > DRY ? b[c - n] + hu : e, ed = hd > DRY ? b[c + n] + hd : e
        const gx = er - el, gz = ed - eu
        const st2 = (gx * gx + gz * gz) / (4 * dx * dx)
        if (st2 > 0.04) src += (Math.sqrt(st2) - 0.2) * 5
        // water against a wall it cannot top
        if (sp2 > 9 && ((hl <= DRY && b[c - 1] > e) || (hr <= DRY && b[c + 1] > e) || (hu <= DRY && b[c - n] > e) || (hd <= DRY && b[c + n] > e))) src += 1.5
        fo = (fo + src * dt) * (land[c] === 1 ? decL : decW)
        tf[c] = fo > 1.3 ? 1.3 : fo
      }
    }
    for (let j = J0; j <= J1; j++) foam.set(tf.subarray(j * n + I0, j * n + I1 + 1), j * n + I0)
  }

  /** Cell-centred velocity at cell c. */
  vel(c: number, out: { x: number; z: number }) {
    const n = this.n, i = c % n, j = (c / n) | 0
    out.x = 0.5 * (this.u[j * (n + 1) + i] + this.u[j * (n + 1) + i + 1])
    out.z = 0.5 * (this.v[c] + this.v[c + n])
    return out
  }

  /** Bed height of the cell under a scene point (0 outside). */
  bedAt(x: number, z: number) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell)
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return 0
    return this.b[j * this.n + i]
  }

  /** Bilinear sample of surface, depth and velocity at a scene point (null outside the grid). */
  sample(x: number, z: number, out: { eta: number; h: number; vx: number; vz: number; bed: number }) {
    const n = this.n
    const fx = (x - this.x0) / this.cell - 0.5, fz = (z - this.z0) / this.cell - 0.5
    if (fx < 0 || fz < 0 || fx >= n - 1 || fz >= n - 1) return null
    const i = fx | 0, j = fz | 0, ax = fx - i, az = fz - j
    const c = j * n + i
    const w00 = (1 - ax) * (1 - az), w10 = ax * (1 - az), w01 = (1 - ax) * az, w11 = ax * az
    const h = this.h, b = this.b
    out.h = h[c] * w00 + h[c + 1] * w10 + h[c + n] * w01 + h[c + n + 1] * w11
    out.bed = b[c] * w00 + b[c + 1] * w10 + b[c + n] * w01 + b[c + n + 1] * w11
    // surface from wet cells only, so a wall next to the water doesn't lift it
    let e = 0, ew = 0
    if (h[c] > DRY) { e += (b[c] + h[c]) * w00; ew += w00 }
    if (h[c + 1] > DRY) { e += (b[c + 1] + h[c + 1]) * w10; ew += w10 }
    if (h[c + n] > DRY) { e += (b[c + n] + h[c + n]) * w01; ew += w01 }
    if (h[c + n + 1] > DRY) { e += (b[c + n + 1] + h[c + n + 1]) * w11; ew += w11 }
    out.eta = ew > 0 ? e / ew : out.bed
    const t = { x: 0, z: 0 }
    let vx = 0, vz = 0
    this.vel(c, t); vx += t.x * w00; vz += t.z * w00
    this.vel(c + 1, t); vx += t.x * w10; vz += t.z * w10
    this.vel(c + n, t); vx += t.x * w01; vz += t.z * w01
    this.vel(c + n + 1, t); vx += t.x * w11; vz += t.z * w11
    out.vx = vx; out.vz = vz
    return out
  }
}

