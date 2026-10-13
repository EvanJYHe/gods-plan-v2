import * as THREE from 'three'
import earcut from 'earcut'
import type { CityData, Poly } from '../data'

/** Ground surfaces from the pack (parks, pavement, roads, rail...) as one flat mesh, plus a far plane to the horizon. */

const SURFACE_COLOURS: Record<string, [number, number, number]> = {
  meadow: [0.34, 0.42, 0.22],
  ground: [0.5, 0.5, 0.44],
  grass: [0.27, 0.43, 0.19],
  sand: [0.78, 0.7, 0.52],
  rail: [0.33, 0.3, 0.27],
  pavement: [0.6, 0.59, 0.55],
  asphalt: [0.13, 0.14, 0.16],
}
const LIFT: Record<string, number> = { meadow: 0.0, ground: 0.03, grass: 0.06, sand: 0.08, rail: 0.1, pavement: 0.13, asphalt: 0.16 }

export const MAX_IMPACTS = 8

function triangulate(poly: Poly, y: number, colour: number[], pos: number[], col: number[]) {
  const [ring, holes] = poly
  const flat: number[] = []
  const holeIdx: number[] = []
  for (let i = 0; i < ring.length; i += 2) flat.push(ring[i] / 10, ring[i + 1] / 10)
  for (const h of holes ?? []) {
    holeIdx.push(flat.length / 2)
    for (let i = 0; i < h.length; i += 2) flat.push(h[i] / 10, h[i + 1] / 10)
  }
  const idx = earcut(flat, holeIdx.length ? holeIdx : undefined)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2]
    const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2])
    const order = cross > 0 ? [a, b, c] : [a, c, b]
    for (const k of order) {
      pos.push(flat[k * 2], y, -flat[k * 2 + 1])
      col.push(colour[0], colour[1], colour[2])
    }
  }
}

let blank: THREE.DataTexture | null = null
function blankWet() {
  if (!blank) {
    blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat)
    blank.needsUpdate = true
  }
  return blank
}

/** Shared uniforms for scorch marks and flood wetness, used by the ground and the far plane. */
export function groundUniforms() {
  return {
    uImpacts: { value: Array.from({ length: MAX_IMPACTS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uImpactGlow: { value: Array.from({ length: MAX_IMPACTS }, () => 0) },
    uWaveOrigin: { value: new THREE.Vector2() },
    uWaveDir: { value: new THREE.Vector2(0, -1) },
    uWaveFront: { value: -1e6 },
    uWaveWet: { value: 0 },
    /** where the flood has been: a wetness map (r: wet 0..1, g: silt) over the box (x0, z0, width, height) in scene xz */
    uWetTex: { value: blankWet() as THREE.Texture },
    uWetBox: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTime: { value: 0 },
    uNight: { value: 0 },
  }
}
export type GroundUniforms = ReturnType<typeof groundUniforms>

export function injectGroundEffects(material: THREE.MeshStandardMaterial, uniforms: GroundUniforms) {
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGWorld;
        uniform vec4 uImpacts[${MAX_IMPACTS}];
        uniform float uImpactGlow[${MAX_IMPACTS}];
        uniform vec2 uWaveOrigin;
        uniform vec2 uWaveDir;
        uniform float uWaveFront;
        uniform float uWaveWet;
        uniform sampler2D uWetTex;
        uniform vec4 uWetBox;
        uniform float uTime;
        float gWet = 0.0;
        uniform float uNight;
        float gStreet = 0.0;
        float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
        }
        float gGlow = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        gStreet = 1.0 - smoothstep(0.14, 0.2, diffuseColor.r);
        // subtle surface grain so large flat areas don't look plastic
        float grain = gNoise(vGWorld.xz * 0.35) * 0.6 + gNoise(vGWorld.xz * 2.1) * 0.4;
        diffuseColor.rgb *= 0.9 + 0.2 * grain;
        // fields and woods out in the countryside
        float fields = gNoise(floor(vGWorld.xz / 260.0) * 1.7) ;
        float woods = smoothstep(0.55, 0.75, gNoise(vGWorld.xz * 0.0011 + 4.0));
        float rural = smoothstep(3500.0, 4500.0, max(abs(vGWorld.x), abs(vGWorld.z) * 1.25));
        diffuseColor.rgb *= mix(1.0, (0.82 + 0.3 * fields) * mix(1.0, 0.62, woods), rural);
        for (int i = 0; i < ${MAX_IMPACTS}; i++) {
          vec4 im = uImpacts[i];
          if (im.z <= 0.0) continue;
          float d = distance(vGWorld.xz, im.xy) / im.z;
          float n = gNoise(vGWorld.xz * 0.02 + float(i) * 7.0) * 0.35 + gNoise(vGWorld.xz * 0.11) * 0.15;
          float scorch = (1.0 - smoothstep(0.35 + n, 1.0 + n, d)) * im.w;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.045, 0.04), clamp(scorch, 0.0, 0.92));
          float crater = 1.0 - smoothstep(0.0, 0.22 + n * 0.3, d);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.02, 0.018), crater * im.w);
          gGlow += crater * uImpactGlow[i] * (0.55 + 0.45 * gNoise(vGWorld.xz * 0.08 + uTime * 0.3));
        }
        // where the flood went: soaked dark and glossy, with silt and grey mud left in streaks along the flow
        if (uWetBox.z > 0.0) {
          vec2 wuv = (vGWorld.xz - uWetBox.xy) / uWetBox.zw;
          if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0) {
            vec4 wt = texture2D(uWetTex, wuv);
            float edge = gNoise(vGWorld.xz * 0.09) * 0.35 + gNoise(vGWorld.xz * 0.5) * 0.15;
            gWet = smoothstep(0.1, 0.5 + edge, wt.r) * uWaveWet;
            float silt = wt.g * smoothstep(0.35, 0.75, gNoise(vGWorld.xz * 0.05) * 0.6 + gNoise(vGWorld.xz * 0.23) * 0.4) * uWaveWet;
            diffuseColor.rgb *= 1.0 - gWet * 0.45;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.19, 0.16), clamp(silt, 0.0, 0.6));
          }
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.2, gWet);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.32, 0.05) * gGlow * 2.5;
        // street lights at night: a warm sodium wash along the roads
        totalEmissiveRadiance += vec3(1.0, 0.6, 0.28) * uNight * gStreet * (0.05 + 0.05 * gNoise(vGWorld.xz * 0.06));`)
  }
}

export function buildGround(data: CityData, uniforms: GroundUniforms): THREE.Group {
  const group = new THREE.Group()
  const pos: number[] = []
  const col: number[] = []
  for (const cls of ['meadow', 'ground', 'grass', 'sand', 'rail', 'pavement', 'asphalt']) {
    for (const poly of data.surfaces[cls] ?? []) triangulate(poly, LIFT[cls], SURFACE_COLOURS[cls], pos, col)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
  injectGroundEffects(mat, uniforms)
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.frustumCulled = false
  group.add(mesh)

  // Land to the horizon beyond the pack, under everything.
  const farMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.29, 0.34, 0.25), roughness: 1 })
  injectGroundEffects(farMat, uniforms)
  const far = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), farMat)
  far.rotation.x = -Math.PI / 2
  far.position.y = -0.5
  far.receiveShadow = true
  group.add(far)
  return group
}
