/** The compiled Toronto pack (scripts/prepare_toronto.py). Coordinates are integer decimetres, x east, z north. */
export type Ring = number[]
export type Poly = [Ring, Ring[]?]

export interface CityData {
  bounds: [number, number, number, number]
  anchors: Record<string, [number, number]>
  categories: string[]
  groups: number
  /** [group, cat, base_dm, height_dm, ring, holes] */
  buildings: [number, number, number, number, Ring, Ring[]][]
  /** [group, cat, [[y0_dm, y1_dm, ring, holes], ...]] */
  massing: [number, number, [number, number, Ring, Ring[]][]][]
  landmarks: { kind: string; name: string; x: number; z: number; h: number; ring: Ring }[]
  surfaces: Record<string, Poly[]>
  water: Poly[]
  farWater: Poly[]
  /** [width_dm, speed_dm, polyline] */
  roads: [number, number, Ring][]
}

export async function loadCity(onProgress?: (p: number) => void): Promise<CityData> {
  const res = await fetch('/data/toronto.json')
  const total = Number(res.headers.get('content-length')) || 9e6
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress?.(Math.min(0.99, got / total))
  }
  const text = new TextDecoder().decode(await new Blob(chunks as BlobPart[]).arrayBuffer())
  return JSON.parse(text) as CityData
}

/** World metres (x east, z north) to three.js (x east, y up, z south). */
export const toScene = (x: number, z: number): [number, number] => [x, -z]
