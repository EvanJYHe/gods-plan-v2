import * as THREE from 'three'
import earcut from 'earcut'
import type { CityData, Poly } from '../data'

/** Lake Ontario and the harbour: animated normals, fresnel to the sky and a sun glint. While a flood simulation runs
 * (fx/flood.ts) the static lake hides inside the flood's box and the flood draws the water there with the same shading. */

export function waterUniforms() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.8).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.9, 0.75) },
    uSkyColor: { value: new THREE.Color(0.55, 0.68, 0.82) },
    uHorizon: { value: new THREE.Color(0.86, 0.82, 0.78) },
    uDeep: { value: new THREE.Color(0.05, 0.16, 0.22) },
    uFogColor: { value: new THREE.Color(0.8, 0.82, 0.84) },
    uFogDensity: { value: 0.00012 },
    uNight: { value: 0 },
    /** scene-xz box (x0, z0, x1, z1) where the flood simulation draws the water instead; empty when x1 <= x0 */
    uFloodBox: { value: new THREE.Vector4(0, 0, 0, 0) },
  }
}
export type WaterUniforms = ReturnType<typeof waterUniforms>

function addPolys(polys: Poly[], pos: number[]) {
  for (const [ring, holes] of polys) {
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
      for (const k of cross > 0 ? [a, b, c] : [a, c, b]) pos.push(flat[k * 2], 0, -flat[k * 2 + 1])
    }
  }
}

const vertex = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`

/** Shared lake shading (uniforms, ripple normals, sky/sun lighting and fog), also used by the flood surface. */
export const WATER_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uHorizon;
  uniform vec3 uDeep;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uNight;
  float wh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wh(i), wh(i + vec2(1, 0)), u.x), mix(wh(i + vec2(0, 1)), wh(i + vec2(1, 1)), u.x), u.y);
  }
  float waves(vec2 p) {
    float t = uTime;
    float v = wn(p * 0.045 + vec2(t * 0.05, t * 0.02)) * 0.5;
    v += wn(p * 0.11 - vec2(t * 0.07, -t * 0.04)) * 0.3;
    v += wn(p * 0.31 + vec2(t * 0.12, t * 0.09)) * 0.15;
    v += wn(p * 0.9 - vec2(t * 0.2, t * 0.15)) * 0.05;
    return v;
  }
  /** ripple slope (x, z) of the calm lake at p */
  vec2 rippleSlope(vec2 p) {
    float e = 0.6;
    float c = waves(p);
    return vec2(c - waves(p + vec2(e, 0.0)), c - waves(p + vec2(0.0, e))) * 6.0;
  }
  /** lit water colour for a surface normal and a body colour (the lake uses uDeep) */
  vec3 shadeWater(vec3 world, vec3 nrm, vec3 body, float reflectivity) {
    vec3 view = normalize(cameraPosition - world);
    float fres = pow(1.0 - max(dot(nrm, view), 0.0), 4.0);
    vec3 refl = reflect(-view, nrm);
    vec3 sky = mix(uHorizon, uSkyColor, smoothstep(0.0, 0.4, refl.y));
    vec3 col = mix(body * (1.0 - 0.8 * uNight), sky * (1.0 - 0.5 * uNight), (0.12 + 0.72 * fres) * reflectivity);
    float spec = pow(max(dot(refl, uSunDir), 0.0), 260.0) * 3.5 + pow(max(dot(refl, uSunDir), 0.0), 24.0) * 0.18;
    col += uSunColor * spec * (1.0 - uNight * 0.85) * reflectivity;
    // city glow on the water at night
    col += vec3(1.0, 0.7, 0.4) * uNight * 0.05 * smoothstep(-2500.0, 0.0, -abs(world.x)) * fres;
    return col;
  }
  vec3 waterFog(vec3 col, vec3 world) {
    float dist = length(cameraPosition - world);
    float fog = 1.0 - exp(-pow(uFogDensity * dist, 1.6));
    return mix(col, uFogColor, clamp(fog, 0.0, 1.0));
  }
`

const fragment = /* glsl */ `
  ${WATER_GLSL}
  uniform vec4 uFloodBox;
  varying vec3 vWorld;
  void main() {
    vec2 p = vWorld.xz;
    if (uFloodBox.z > uFloodBox.x && p.x > uFloodBox.x && p.x < uFloodBox.z && p.y > uFloodBox.y && p.y < uFloodBox.w) discard;
    vec2 s = rippleSlope(p);
    vec3 nrm = normalize(vec3(s.x, 1.0, s.y));
    vec3 col = shadeWater(vWorld, nrm, uDeep, 1.0);
    gl_FragColor = vec4(waterFog(col, vWorld), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

export function buildWater(data: CityData, uniforms: WaterUniforms): THREE.Mesh {
  const pos: number[] = []
  addPolys(data.water, pos)
  addPolys(data.farWater, pos)
  // Lake Ontario beyond the pack, out to the horizon (world z is north, so these rings are in decimetres, z negative)
  const [bx0, bz0, bx1] = data.bounds
  const rect = (x0: number, z0: number, x1: number, z1: number): [number[]] => [[x0 * 10, z0 * 10, x1 * 10, z0 * 10, x1 * 10, z1 * 10, x0 * 10, z1 * 10]]
  addPolys([rect(-40000, -40000, 40000, bz0 + 1)], pos)
  addPolys([rect(-40000, bz0 + 1, bx0 + 1, -1100), rect(bx1 - 1, bz0 + 1, 40000, -1100)], pos)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = 0.2
  mesh.frustumCulled = false
  return mesh
}
