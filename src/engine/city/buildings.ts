import * as THREE from 'three'
import earcut from 'earcut'
import type { CityData, Ring } from '../data'

/**
 * Every building in one merged mesh. Each vertex carries its building's index; two float textures hold per-building
 * facts (centre, radius, height) and live state (collapse, tilt, tilt direction, scorch / wet, burning), so the vertex
 * shader can crumble, tilt and char thousands of buildings at once while the CPU only writes a few numbers per building.
 */

export const STATE_WIDTH = 256

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return s - Math.floor(s)
}

// Facade colours by category (linear-ish sRGB, gently varied per building).
const PALETTE: Record<string, [number, number, number][]> = {
  residential: [[0.72, 0.52, 0.42], [0.62, 0.4, 0.33], [0.82, 0.74, 0.62], [0.55, 0.36, 0.3], [0.78, 0.68, 0.56]],
  apartments: [[0.8, 0.77, 0.71], [0.68, 0.63, 0.57], [0.58, 0.56, 0.55], [0.7, 0.58, 0.5]],
  office: [[0.42, 0.52, 0.6], [0.55, 0.62, 0.68], [0.74, 0.75, 0.74], [0.36, 0.42, 0.48]],
  tower: [[0.32, 0.42, 0.52], [0.42, 0.52, 0.6], [0.28, 0.36, 0.44], [0.62, 0.66, 0.68], [0.5, 0.58, 0.62]],
  commercial: [[0.82, 0.78, 0.7], [0.7, 0.66, 0.6], [0.6, 0.62, 0.64]],
  retail: [[0.84, 0.78, 0.68], [0.74, 0.6, 0.5], [0.66, 0.6, 0.56]],
  hotel: [[0.8, 0.74, 0.64], [0.52, 0.58, 0.62]],
  civic: [[0.84, 0.8, 0.72], [0.74, 0.7, 0.62]],
  industrial: [[0.6, 0.6, 0.58], [0.5, 0.52, 0.52], [0.58, 0.5, 0.44]],
  utility: [[0.58, 0.58, 0.56]],
  landmark: [[0.82, 0.8, 0.76]],
  generic: [[0.78, 0.75, 0.7], [0.66, 0.62, 0.58], [0.72, 0.64, 0.56], [0.6, 0.6, 0.6]],
}

export interface BuildingInfo {
  /** centre x, scene z, footprint radius, top height, base height */
  cx: number
  cz: number
  r: number
  top: number
  base: number
}

class Builder {
  pos: number[] = []
  nor: number[] = []
  col: number[] = []
  bld: number[] = []
  /** wall coordinate along the perimeter (m), height (m), roof flag, building top (m) */
  info: number[] = []

  push(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number[], b: number, u: number, roof: number, top: number) {
    this.pos.push(x, y, z)
    this.nor.push(nx, ny, nz)
    this.col.push(c[0], c[1], c[2])
    this.bld.push(b)
    this.info.push(u, y, roof, top)
  }

  /** Walls of a ring (decimetre world coords) from y0 to y1, outward-facing. */
  walls(ring: Ring, y0: number, y1: number, c: number[], b: number, top: number, hole = false) {
    const n = ring.length / 2
    let area = 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1]
    }
    // In world coords (z north) a counter-clockwise ring has positive area; outward normal is (dz, -dx).
    const ccw = (area > 0) !== hole
    let u = 0
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const ax = ring[i * 2] / 10, az = ring[i * 2 + 1] / 10
      const bx = ring[j * 2] / 10, bz = ring[j * 2 + 1] / 10
      const dx = bx - ax, dz = bz - az
      const len = Math.hypot(dx, dz)
      if (len < 0.05) continue
      let nx = dz / len, nz = -dx / len
      if (!ccw) { nx = -nx; nz = -nz }
      // scene coords: x, y, -z
      const sx0 = ax, sz0 = -az, sx1 = bx, sz1 = -bz
      const snx = nx, snz = -nz
      const u0 = u, u1 = u + len
      const tri = ccw
        ? [[sx0, y0, sz0, u0], [sx1, y0, sz1, u1], [sx1, y1, sz1, u1], [sx0, y0, sz0, u0], [sx1, y1, sz1, u1], [sx0, y1, sz0, u0]]
        : [[sx0, y0, sz0, u0], [sx1, y1, sz1, u1], [sx1, y0, sz1, u1], [sx0, y0, sz0, u0], [sx0, y1, sz0, u0], [sx1, y1, sz1, u1]]
      for (const [x, y, z, uu] of tri) this.push(x, y, z, snx, 0, snz, c, b, uu, 0, top)
      u = u1
    }
  }

  /** Flat roof polygon at height y. */
  roof(ring: Ring, holes: Ring[] | undefined, y: number, c: number[], b: number, top: number) {
    const flat: number[] = []
    const holeIdx: number[] = []
    for (let i = 0; i < ring.length; i += 2) flat.push(ring[i] / 10, ring[i + 1] / 10)
    for (const h of holes ?? []) {
      holeIdx.push(flat.length / 2)
      for (let i = 0; i < h.length; i += 2) flat.push(h[i] / 10, h[i + 1] / 10)
    }
    const idx = earcut(flat, holeIdx.length ? holeIdx : undefined)
    for (let t = 0; t < idx.length; t += 3) {
      // earcut keeps the ring's winding; emit triangles facing up in scene space (z flipped -> reverse order)
      const a = idx[t], bb = idx[t + 1], cc = idx[t + 2]
      const ax = flat[a * 2], az = flat[a * 2 + 1], bx = flat[bb * 2], bz = flat[bb * 2 + 1], cx = flat[cc * 2], cz = flat[cc * 2 + 1]
      const cross = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
      const order = cross > 0 ? [a, bb, cc] : [a, cc, bb]
      for (const k of order) this.push(flat[k * 2], y, -flat[k * 2 + 1], 0, 1, 0, c, b, 0, 1, top)
    }
  }
}

export class Buildings {
  readonly mesh: THREE.Mesh
  readonly count: number
  readonly info: BuildingInfo[]
  /** collapse 0..1, tilt (rad), tilt direction (rad), scorch 0..1 */
  readonly state: Float32Array
  /** wet 0..1, burning 0..1, shake 0..1, shatter 0..1 (cells blown out of the structure) */
  readonly state2: Float32Array
  /** facade colour per building (rgb) */
  readonly colors: Float32Array
  private stateTex: THREE.DataTexture
  private state2Tex: THREE.DataTexture
  private infoTex: THREE.DataTexture
  readonly uniforms = {
    uState: { value: null as THREE.DataTexture | null },
    uState2: { value: null as THREE.DataTexture | null },
    uInfo: { value: null as THREE.DataTexture | null },
    uTime: { value: 0 },
    uNight: { value: 0 },
  }
  private dirty = false

  constructor(data: CityData) {
    const n = data.groups
    this.count = n
    const rows = Math.ceil(n / STATE_WIDTH)
    this.state = new Float32Array(STATE_WIDTH * rows * 4)
    this.state2 = new Float32Array(STATE_WIDTH * rows * 4)
    const infoArr = new Float32Array(STATE_WIDTH * rows * 4)
    this.colors = new Float32Array(n * 3).fill(0.7)
    const b = new Builder()
    const cats = data.categories
    // per-group extents
    const minX = new Float64Array(n).fill(Infinity), maxX = new Float64Array(n).fill(-Infinity)
    const minZ = new Float64Array(n).fill(Infinity), maxZ = new Float64Array(n).fill(-Infinity)
    const top = new Float64Array(n), base = new Float64Array(n).fill(Infinity)
    const extend = (g: number, ring: Ring, y0: number, y1: number) => {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i] / 10, z = -ring[i + 1] / 10
        if (x < minX[g]) minX[g] = x
        if (x > maxX[g]) maxX[g] = x
        if (z < minZ[g]) minZ[g] = z
        if (z > maxZ[g]) maxZ[g] = z
      }
      if (y1 > top[g]) top[g] = y1
      if (y0 < base[g]) base[g] = y0
    }
    for (const [g, , b0, h, ring] of data.buildings) extend(g, ring, b0 / 10, (b0 + h) / 10)
    for (const [g, , tiers] of data.massing) for (const [y0, y1, ring] of tiers) extend(g, ring, y0 / 10, y1 / 10)

    const colourOf = (g: number, cat: number) => {
      const pal = PALETTE[cats[cat]] ?? PALETTE.generic
      const p = pal[Math.floor(hash(g) * pal.length)]
      const v = (0.92 + hash(g + 7.1) * 0.14) * 0.82
      return [p[0] * v, p[1] * v, p[2] * v]
    }
    const roofColour = (g: number) => {
      const s = hash(g + 3.3)
      return s > 0.7 ? [0.6, 0.6, 0.57] : s > 0.3 ? [0.46, 0.47, 0.46] : [0.38, 0.4, 0.41]
    }
    for (const [g, cat, b0, h, ring, holes] of data.buildings) {
      const y0 = b0 / 10, y1 = (b0 + h) / 10
      const c = colourOf(g, cat)
      this.colors.set(c, g * 3)
      b.walls(ring, y0, y1, c, g, top[g])
      for (const hole of holes ?? []) b.walls(hole, y0, y1, c, g, top[g], true)
      b.roof(ring, holes, y1, roofColour(g), g, top[g])
    }
    for (const [g, cat, tiers] of data.massing) {
      const c = colourOf(g, cat === 0 ? 2 : cat)
      this.colors.set(c, g * 3)
      for (const [y0d, y1d, ring, holes] of tiers) {
        const y0 = y0d / 10, y1 = y1d / 10
        b.walls(ring, y0, y1, c, g, top[g])
        for (const hole of holes ?? []) b.walls(hole, y0, y1, c, g, top[g], true)
        b.roof(ring, holes, y1, roofColour(g), g, top[g])
      }
    }

    this.info = []
    for (let g = 0; g < n; g++) {
      const ok = Number.isFinite(minX[g])
      const cx = ok ? (minX[g] + maxX[g]) / 2 : 0, cz = ok ? (minZ[g] + maxZ[g]) / 2 : 0
      const r = ok ? Math.max(maxX[g] - minX[g], maxZ[g] - minZ[g]) / 2 : 0
      const bs = Number.isFinite(base[g]) ? base[g] : 0
      this.info.push({ cx, cz, r, top: top[g], base: bs })
      infoArr.set([cx, cz, r, top[g]], g * 4)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3))
    geo.setAttribute('aBuilding', new THREE.Float32BufferAttribute(b.bld, 1))
    geo.setAttribute('aInfo', new THREE.Float32BufferAttribute(b.info, 4))
    geo.computeBoundingSphere()

    const tex = (arr: Float32Array) => {
      const t = new THREE.DataTexture(arr, STATE_WIDTH, rows, THREE.RGBAFormat, THREE.FloatType)
      t.minFilter = t.magFilter = THREE.NearestFilter
      t.needsUpdate = true
      return t
    }
    this.stateTex = tex(this.state)
    this.state2Tex = tex(this.state2)
    this.infoTex = tex(infoArr)
    this.uniforms.uState.value = this.stateTex
    this.uniforms.uState2.value = this.state2Tex
    this.uniforms.uInfo.value = this.infoTex

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide })
    material.onBeforeCompile = shader => this.inject(shader, false)
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    depth.onBeforeCompile = shader => this.inject(shader, true)
    this.mesh = new THREE.Mesh(geo, material)
    material.shadowSide = THREE.BackSide
    this.mesh.customDepthMaterial = depth
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false
  }

  /** Mark state as changed; uploaded once per frame. */
  touch() { this.dirty = true }

  update(time: number, night: number) {
    this.uniforms.uTime.value = time
    this.uniforms.uNight.value = night
    if (this.dirty) {
      this.stateTex.needsUpdate = true
      this.state2Tex.needsUpdate = true
      this.dirty = false
    }
  }

  reset() {
    this.state.fill(0)
    this.state2.fill(0)
    this.touch()
  }

  private inject(shader: THREE.WebGLProgramParametersWithUniforms, depthOnly: boolean) {
    Object.assign(shader.uniforms, this.uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBuilding;
        attribute vec4 aInfo;
        uniform sampler2D uState;
        uniform sampler2D uState2;
        uniform sampler2D uInfo;
        uniform float uTime;
        varying vec4 vInfo;
        varying vec4 vState;
        varying vec4 vState2;
        varying vec3 vWorld;
        varying float vSeed;
        varying vec3 vLocal;
        varying vec3 vObjN;
        varying vec4 vBld;
        float gpHash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
        vec3 gpRotate(vec3 p, vec3 axis, float a) {
          float c = cos(a), s = sin(a);
          return p * c + cross(axis, p) * s + axis * dot(axis, p) * (1.0 - c);
        }
        vec4 gpState; vec4 gpState2; vec4 gpInfo; vec3 gpAxis; float gpTilt;
        void gpFetch() {
          ivec2 cell = ivec2(int(mod(aBuilding, ${STATE_WIDTH}.0)), int(floor(aBuilding / ${STATE_WIDTH}.0)));
          gpState = texelFetch(uState, cell, 0);
          gpState2 = texelFetch(uState2, cell, 0);
          gpInfo = texelFetch(uInfo, cell, 0);
          gpTilt = gpState.y;
          vec2 dir = vec2(cos(gpState.z), sin(gpState.z));
          gpAxis = abs(gpTilt) > 0.0001 ? normalize(vec3(-dir.y, 0.0, dir.x)) : vec3(0.0, 0.0, 1.0);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        gpFetch();
        if (abs(gpTilt) > 0.0001) objectNormal = gpRotate(objectNormal, gpAxis, -gpTilt);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        gpFetch();
        {
          float collapse = gpState.x;
          float topH = max(gpInfo.w, 1.0);
          float seed = gpHash(aBuilding);
          vLocal = transformed;
          vObjN = normal;
          // a collapsing building settles into its own footprint as it is eaten away from the top (the fragment
          // shader carves it in cells); the sink is a fixed share of the height so the ragged stump stays standing
          float stump = min(topH, 3.0 + topH * 0.1);
          transformed.y -= collapse * 0.3 * max(topH - stump, 0.0);
          // tilt about the footprint's edge, away from the blast
          if (abs(gpTilt) > 0.0001) {
            vec2 dir = vec2(cos(gpState.z), sin(gpState.z));
            vec3 pivot = vec3(gpInfo.x + dir.x * gpInfo.z, 0.0, gpInfo.y + dir.y * gpInfo.z);
            transformed = pivot + gpRotate(transformed - pivot, gpAxis, -gpTilt);
          }
          // a shiver while the shockwave passes
          float sh = gpState2.z;
          float rel = clamp(vLocal.y / topH, 0.0, 1.0);
          transformed.xz += sh * vec2(sin(uTime * 61.0 + seed * 20.0), cos(uTime * 53.0 + seed * 11.0)) * 0.35 * rel;
          vInfo = aInfo;
          vState = gpState;
          vState2 = gpState2;
          vSeed = seed;
          vBld = gpInfo;
          vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          ${depthOnly ? '' : `// intact buildings never show their insides: drop their back faces (the material is double-sided for ruins)
          // and in ruins a back face sits a hair behind any front face it shares a plane with (the city has overlapping
          // footprints), so the dark interior never z-fights through a facade
          if (dot(objectNormal, cameraPosition - vWorld) < 0.0) {
            if (collapse <= 0.0 && gpState2.w < 0.13) transformed = vec3(0.0, -1e5, 0.0);
            else {
              vec3 ray = vWorld - cameraPosition;
              float dist = length(ray);
              transformed += ray / dist * (0.4 + dist * 0.003);
            }
          }`}
        }`)
    const carve = /* glsl */ `
        varying vec4 vState;
        varying vec4 vState2;
        varying vec3 vWorld;
        varying float vSeed;
        varying vec3 vLocal;
        varying vec3 vObjN;
        varying vec4 vBld;
        float gpH3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
        float gpVN(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(gpH3(i), gpH3(i + vec3(1, 0, 0)), f.x), mix(gpH3(i + vec3(0, 1, 0)), gpH3(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(gpH3(i + vec3(0, 0, 1)), gpH3(i + vec3(1, 0, 1)), f.x), mix(gpH3(i + vec3(0, 1, 1)), gpH3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        // How far this fragment is from being carved away (negative: it's gone). Buildings break in world-space
        // cells about a storey high: blown out first on the side facing the blast, at the top and the corners,
        // and eaten from the top down by the collapse front, which is ragged cell by cell.
        float gpCarve() {
          float collapse = vState.x, shatter = vState2.w;
          if (collapse <= 0.0 && shatter <= 0.0) return 9.0;
          float topH = max(vBld.w, 1.0);
          vec3 q = vLocal - vObjN * 0.7;
          // blocks two storeys high, carved where a smooth field over the blocks dips, so the holes are big
          // connected bites with blocky edges, not confetti
          vec3 cell = floor(q / vec3(4.5, 7.2, 4.5));
          float h = gpVN(cell * vec3(0.32, 0.45, 0.32) + vSeed * 37.0) * 0.82 + gpH3(cell + vSeed * 31.0) * 0.18;
          float h2 = gpH3(cell.zxy + vSeed * 17.0 + 5.0);
          float rel = clamp(q.y / topH, 0.0, 1.0);
          vec2 off = (q.xz - vBld.xy) / max(vBld.z, 4.0);
          vec2 dir = vec2(cos(vState.z), sin(vState.z));
          float facing = -dot(off, dir);
          float edge = clamp(length(off), 0.0, 1.4);
          float stump = min(topH, 3.0 + topH * 0.1);
          float D = 0.3 * max(topH - stump, 0.0);
          float yFront = mix(topH + 4.0, stump, collapse) + collapse * D;
          float m1 = yFront + (h2 - 0.5) * 8.0 * smoothstep(0.0, 0.2, collapse) - q.y;
          float nearFront = (1.0 - smoothstep(0.0, 14.0, m1)) * smoothstep(0.0, 0.1, collapse);
          // it goes from the corner facing the blast, the top and the edges inward
          float sh = shatter * (0.95 + 0.8 * rel + 0.45 * edge + 0.8 * facing) - 0.42 + 0.25 * shatter * shatter;
          sh -= 0.7 * (1.0 - smoothstep(stump + D - 2.0, stump + D + 6.0, q.y)) * shatter;
          float m2 = h - max(sh, nearFront * 0.55);
          return min(m1, m2 * 10.0);
        }`
    if (depthOnly) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          ${carve}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          if (vWorld.y < -0.05 || gpCarve() < 0.0) discard;`)
      return
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uNight;
        varying vec4 vInfo;
        ${carve}
        float gpHash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gpMargin;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        gpMargin = gpCarve();
        if (vWorld.y < -0.05 || gpMargin < 0.0) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gpRoof = vInfo.z;
        float gpWindow = 0.0;
        float gpLit = 0.0;
        if (gpRoof < 0.5 && vInfo.w > 7.0) {
          // a grid of windows: floors every 3.6 m, bays every 3 m
          float u = vInfo.x / 3.0;
          float v = (vInfo.y - 1.2) / 3.6;
          vec2 cell = floor(vec2(u, v));
          vec2 f = fract(vec2(u, v));
          vec2 fw = fwidth(vec2(u, v));
          float detail = 1.0 - smoothstep(0.18, 0.5, max(fw.x, fw.y));
          float w = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78) * step(0.0, v);
          // far away: the average of the pattern (about 36% glass) instead of shimmering stripes
          float coverage = mix(0.36 * step(0.0, v), w, detail);
          gpWindow = coverage;
          float r = gpHash2(cell + vSeed * 97.0);
          float lit = w * step(0.66, r) * (0.55 + 0.45 * gpHash2(cell.yx + 3.0));
          gpLit = mix(0.028 * step(0.0, v) * (0.3 + gpHash2(vec2(vSeed, 2.0)) * 1.4), lit, detail);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.42, 0.48, 0.56), coverage * 0.75);
        }
        // grime toward the ground, a little light at the top
        diffuseColor.rgb *= 0.84 + 0.16 * smoothstep(0.0, 0.3, vInfo.y / 12.0);
        // scorch and wet
        float scorch = vState.w;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.045, 0.04, 0.035), clamp(scorch * (0.75 + 0.25 * gpHash2(vWorld.xz * 0.3)), 0.0, 1.0));
        float wet = vState2.x;
        float waterLine = step(vWorld.y, 2.0 + 18.0 * wet);
        diffuseColor.rgb *= mix(1.0, 0.62, wet * waterLine);
        // a breaking building goes dusty grey; the collapse front and the stump are bare concrete
        float gpFront = 1.0 - smoothstep(0.0, 6.0, gpMargin);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.4, 0.385, 0.36), clamp(vState2.w * 0.3 + vState.x * 0.35 + gpFront * 0.5, 0.0, 0.8));
        // inside a broken building: dark rooms with the floor slabs showing
        if (!gl_FrontFacing) {
          float slab = smoothstep(0.82, 0.9, fract(vLocal.y / 3.6)) * (1.0 - smoothstep(0.96, 1.0, fract(vLocal.y / 3.6)));
          diffuseColor.rgb = mix(vec3(0.05, 0.045, 0.04), vec3(0.3, 0.29, 0.27), slab) * (1.0 - scorch * 0.6);
          gpWindow = 0.0;
          gpLit = 0.0;
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.28, gpWindow * (1.0 - vState.w));
        roughnessFactor = mix(roughnessFactor, 0.35, vState2.x * 0.6);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float flick = 0.75 + 0.25 * sin(uTime * 9.0 + vSeed * 40.0 + vWorld.y * 0.3);
        totalEmissiveRadiance += vec3(1.0, 0.74, 0.44) * gpLit * uNight * uNight * 2.4 * (1.0 - vState.w) * (1.0 - vState.x);
        // embers and fire on burning buildings, brightest along the broken edges and inside
        float burn = vState2.y;
        // a few windows burning (sparse, so it reads as fires, not a pattern), more low down and inside the ruin
        vec2 room = floor(vec2(vInfo.x / 3.0, vLocal.y / 3.6));
        float fireRoom = step(0.95 - 0.08 * burn * (gl_FrontFacing ? 0.0 : 1.0), gpHash2(room + vSeed * 13.0)) * gpWindow;
        float embers = burn * fireRoom * (0.6 + 0.4 * smoothstep(30.0, 0.0, vLocal.y));
        float edgeGlow = burn * (1.0 - smoothstep(0.0, 2.0, gpMargin)) * step(0.7, gpHash2(floor(vLocal.xz * 0.25) + floor(vLocal.y * 0.28)));
        totalEmissiveRadiance += vec3(1.0, 0.36, 0.06) * (embers * 3.0 + edgeGlow * 1.2 + burn * 0.25 * smoothstep(8.0, 0.0, vWorld.y)) * flick;`)
  }
}
