import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { CityData } from '../data'

/** The four modelled landmarks. Each can sink, tilt and char like a building, driven from the CPU. */

const MODELS = ['rogers_centre', 'union_station', 'scotiabank_arena']

export interface Landmark {
  kind: string
  name: string
  root: THREE.Group
  pivot: THREE.Group
  x: number
  z: number
  h: number
  r: number
  collapse: number
  tilt: number
  tiltDir: number
  scorch: number
  materials: THREE.MeshStandardMaterial[]
  baseColors: THREE.Color[]
}

/** The CN Tower, built to its real proportions: hexagonal core and three tapering wings, the main pod with its
 * glass band at 346 m, the SkyPod at 447 m and the antenna to 553 m. */
function cnTower(): THREE.Group {
  const g = new THREE.Group()
  const concrete = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.66, 0.64, 0.6), roughness: 0.85 })
  const glass = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.1, 0.13, 0.16), roughness: 0.22, metalness: 0.55 })
  const white = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.8, 0.8, 0.78), roughness: 0.6 })
  const red = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.62, 0.1, 0.08), roughness: 0.6 })
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => g.add(new THREE.Mesh(geo, mat))
  const core = new THREE.CylinderGeometry(6.2, 10.5, 330, 6)
  core.translate(0, 165, 0)
  add(core, concrete)
  // three wings whose outer edge sweeps in toward the core as they rise
  for (let k = 0; k < 3; k++) {
    const pos: number[] = []
    const steps = 18
    const edge = (y: number) => 6 + 27 * Math.pow(1 - y / 330, 1.7)
    const t = 3.2
    for (let i = 0; i < steps; i++) {
      const y0 = (i / steps) * 330, y1 = ((i + 1) / steps) * 330
      const r0 = edge(y0), r1 = edge(y1)
      const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d)
      // two faces and the outer edge of a slab running from the core (x = 0) out to r
      quad([0, y0, t], [r0, y0, t], [r1, y1, t], [0, y1, t])
      quad([r0, y0, -t], [0, y0, -t], [0, y1, -t], [r1, y1, -t])
      quad([r0, y0, t], [r0, y0, -t], [r1, y1, -t], [r1, y1, t])
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.computeVertexNormals()
    geo.rotateY((k * Math.PI * 2) / 3 + Math.PI / 6)
    add(geo, concrete)
  }
  const lathe = (pts: [number, number][], mat: THREE.Material, seg = 48) => add(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg), mat)
  lathe([[6, 324], [13, 329], [20, 335], [23, 340.5]], concrete)
  lathe([[23, 340.5], [23.6, 346], [23, 351.5]], glass)
  lathe([[23, 351.5], [21.5, 357], [16, 363], [9, 367], [6, 369]], white)
  const upper = new THREE.CylinderGeometry(5, 5.9, 78, 12)
  upper.translate(0, 369 + 39, 0)
  add(upper, concrete)
  lathe([[5, 444], [9.2, 446.5], [9.6, 449.5], [8.2, 452.5], [4.4, 455]], glass)
  for (let i = 0; i < 6; i++) {
    const y0 = 455 + i * 16.3
    const a = new THREE.CylinderGeometry(3.1 - (i + 1) * 0.33, 3.1 - i * 0.33, 16.3, 10)
    a.translate(0, y0 + 8.15, 0)
    add(a, i % 2 ? white : red)
  }
  g.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = true; m.receiveShadow = true } })
  return g
}

export async function loadLandmarks(data: CityData, scene: THREE.Scene, clip: THREE.Plane): Promise<Landmark[]> {
  const loader = new GLTFLoader()
  const out: Landmark[] = []
  const cn = data.landmarks.find(l => l.kind === 'cn_tower')
  if (cn) {
    const root = new THREE.Group()
    const pivot = new THREE.Group()
    root.position.set(cn.x, 0, -cn.z)
    root.add(pivot)
    const model = cnTower()
    pivot.add(model)
    const materials: THREE.MeshStandardMaterial[] = []
    model.traverse(o => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      const mat = m.material as THREE.MeshStandardMaterial
      mat.clippingPlanes = [clip]
      if (!materials.includes(mat)) materials.push(mat)
    })
    scene.add(root)
    out.push({ kind: 'cn_tower', name: cn.name, root, pivot, x: cn.x, z: -cn.z, h: 553, r: 22, collapse: 0, tilt: 0, tiltDir: 0, scorch: 0, materials, baseColors: materials.map(m => m.color.clone()) })
  }
  await Promise.all(data.landmarks.filter(l => MODELS.includes(l.kind)).map(async l => {
    try {
      const gltf = await loader.loadAsync(`/models/${l.kind}.glb`)
      const root = new THREE.Group()
      const pivot = new THREE.Group()
      root.position.set(l.x, 0, -l.z)
      root.add(pivot)
      const model = gltf.scene
      pivot.add(model)
      const box = new THREE.Box3().setFromObject(model)
      const r = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / 2
      const materials: THREE.MeshStandardMaterial[] = []
      model.traverse(o => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.castShadow = true
        m.receiveShadow = true
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]
        for (const mat of mats) {
          if (!materials.includes(mat)) mat.color.multiplyScalar(0.78)
          mat.clippingPlanes = [clip]
          mat.envMapIntensity = 0.8
          if (!materials.includes(mat)) materials.push(mat)
        }
      })
      scene.add(root)
      out.push({ kind: l.kind, name: l.name, root, pivot, x: l.x, z: -l.z, h: Math.max(l.h, box.max.y), r, collapse: 0, tilt: 0, tiltDir: 0, scorch: 0, materials, baseColors: materials.map(m => m.color.clone()) })
    } catch (error) {
      console.warn(`landmark ${l.kind} failed to load`, error)
    }
  }))
  return out
}

const CHAR = new THREE.Color(0.05, 0.045, 0.04)

/** Apply a landmark's state to its transform and materials. */
export function applyLandmark(l: Landmark) {
  const k = THREE.MathUtils.smoothstep(l.collapse, 0, 1)
  l.root.position.y = -k * l.h * 1.05
  // tilt about the base edge, away from the blast
  const dx = Math.cos(l.tiltDir), dz = Math.sin(l.tiltDir)
  l.pivot.position.set(dx * l.r, 0, dz * l.r)
  l.pivot.children[0].position.set(-dx * l.r, 0, -dz * l.r)
  const axis = new THREE.Vector3(-dz, 0, dx).normalize()
  l.pivot.quaternion.setFromAxisAngle(axis, -l.tilt)
  l.materials.forEach((m, i) => m.color.copy(l.baseColors[i]).lerp(CHAR, Math.min(0.9, l.scorch)))
}

export function resetLandmark(l: Landmark) {
  l.collapse = l.tilt = l.scorch = 0
  applyLandmark(l)
}
