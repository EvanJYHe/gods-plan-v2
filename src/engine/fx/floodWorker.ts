import { Flood } from './flood'

/** Runs the flood simulation off the main thread in real time; the main thread keeps a mirror it reads from. */

export interface FloodInit {
  type: 'init'
  n: number; cell: number; x0: number; z0: number; g: number
  rect: [number, number, number, number]
  fields: Record<string, Float32Array | Int32Array | Uint8Array>
}
export interface FloodStep {
  type: 'step'
  dt: number
  slope: number; drain: number; calm: number; inflow: number; inflowV: number
  beds: [Int32Array, number][]
  wakes: [number, number, number, number][]
}
export interface FloodResult {
  rect: [number, number, number, number]
  fields: Record<string, Float32Array>
  ms: number
}

let f: Flood | null = null
const rect = (x: Flood): [number, number, number, number] => [x.i0, x.i1, x.j0, x.j1]

self.onmessage = (ev: MessageEvent<FloodInit | FloodStep>) => {
  const m = ev.data
  if (m.type === 'init') {
    f = new Flood(m.n, m.cell, m.x0, m.z0)
    f.g = m.g
    for (const [k, a] of Object.entries(m.fields)) (f as unknown as Record<string, Float32Array>)[k].set(a as Float32Array)
    ;[f.i0, f.i1, f.j0, f.j1] = m.rect
    return
  }
  if (!f) return
  const t = performance.now()
  for (const [cells, y] of m.beds) for (const c of cells) if (f.b[c] > y) f.b[c] = y
  for (const w of m.wakes) f.wake(...w)
  f.slope = m.slope; f.drain = m.drain; f.calm = m.calm; f.inflow = m.inflow; f.inflowV = m.inflowV
  const dt = Math.min(m.dt, 0.12)
  const steps = Math.ceil(dt / 0.045)
  for (let s = 0; s < steps; s++) f.step(dt / steps)
  f.foamStep(dt)
  const fields: Record<string, Float32Array> = {}
  for (const k of Flood.LIVE) fields[k] = f[k].slice()
  const res: FloodResult = { rect: rect(f), fields, ms: performance.now() - t }
  ;(self as unknown as Worker).postMessage(res, Object.values(fields).map(a => a.buffer))
}
