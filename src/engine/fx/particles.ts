import * as THREE from 'three'

let seed = 0x51ed270b
/** mulberry32: independent of Math.random, which the film recorder replaces with a weak generator */
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * Billboard particles whose whole life is computed in the vertex shader from their spawn data (position, velocity,
 * drag, gravity, buoyancy, turbulence), so emitting is a small buffer write and simulating costs nothing on the CPU.
 * Two pools: soft "matter" (smoke, dust, spray, cloud) blended normally, and "light" (fire, sparks, glow) added.
 * Mode 1 particles orbit a rising torus: the rolling cap of a mushroom cloud.
 */

export const Kind = { Smoke: 0, Dust: 1, Spray: 2, Fire: 3, Spark: 4, Glow: 5, Cloud: 6 } as const
export type Kind = (typeof Kind)[keyof typeof Kind]

export interface Emit {
  x: number; y: number; z: number
  vx?: number; vy?: number; vz?: number
  life: number
  size0: number; size1: number
  r: number; g: number; b: number; a?: number
  drag?: number; gravity?: number; buoyancy?: number; turb?: number
  spin?: number
  kind: Kind
  delay?: number
  /** mushroom cap: [centre angle, torus radius, phase, 1] with the cap centre in x,y,z */
  orbit?: [number, number, number]
  /** rise speed and growth for orbiting particles */
  rise?: number
  /** incandescence 0..1: young nuke smoke glows orange from inside, cooling over a few seconds */
  heat?: number
}

const vertex = /* glsl */ `
  attribute vec3 aP0;
  attribute vec3 aV0;
  attribute vec4 aT;      // t0, life, seed, kind
  attribute vec4 aSize;   // size0, size1, spin, heat
  attribute vec4 aColor;
  attribute vec4 aPhys;   // drag, gravity, buoyancy, turbulence
  attribute vec4 aOrbit;  // angle, torus radius, phase, rise speed (0 = not orbiting)
  uniform float uTime;
  uniform vec3 uSunDir;
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vKind;
  varying vec3 vWorld;
  varying vec2 vUpUv;
  varying vec3 vSun3;
  varying float vShade;
  varying float vHeat;
  float h1(float n) { return fract(sin(n) * 43758.5453); }
  vec3 turbulence(vec3 p, float t, float s) {
    return vec3(
      sin(p.y * 0.011 + t * 0.7 + s * 6.0) + sin(p.z * 0.017 + t * 0.4),
      sin(p.x * 0.013 + t * 0.5 + s * 3.0) * 0.4,
      sin(p.x * 0.012 - t * 0.6 + s * 9.0) + sin(p.y * 0.019 + t * 0.3));
  }
  void main() {
    float age = uTime - aT.x;
    float life = aT.y;
    float k = age / life;
    vUv = uv;
    vSeed = aT.z;
    vKind = aT.w;
    if (age < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); return; }
    vec3 p;
    vShade = 1.0;
    if (aOrbit.w > 0.0) {
      // rolling torus: the cap rises and widens; each particle circles the torus tube while the ring turns
      float rise = aOrbit.w;
      float grow = 1.0 - exp(-age * 0.25);
      float R = aOrbit.y * (0.55 + 0.75 * grow);
      float tube = R * 0.42;
      float phi = aOrbit.z - age * 0.55;
      float theta = aOrbit.x + age * 0.03;
      vec3 c = aP0 + vec3(0.0, rise * (1.0 - exp(-age * 0.12)) / 0.12, 0.0);
      vec3 radial = vec3(cos(theta), 0.0, sin(theta));
      p = c + radial * (R + cos(phi) * tube) + vec3(0.0, sin(phi) * tube * 0.8, 0.0);
      // the underside of the rolling cap sits in its own shadow
      vShade = 0.38 + 0.62 * smoothstep(-0.8, 0.9, sin(phi));
    } else {
      float d = max(aPhys.x, 0.0001);
      float e = exp(-d * age);
      p = aP0 + aV0 * (1.0 - e) / d;
      vec3 acc = vec3(0.0, aPhys.z - aPhys.y, 0.0);
      p += acc / d * (age - (1.0 - e) / d);
      p += turbulence(aP0 + p * 0.3, uTime, aT.z) * aPhys.w * k;
    }
    float size = mix(aSize.x, aSize.y, 1.0 - pow(1.0 - k, 2.2));
    if (aT.w < 2.5) p.y = max(p.y, size * 0.32);
    vWorld = p;
    vAge = k;
    vColor = aColor;
    vec4 mv = viewMatrix * vec4(p, 1.0);
    float ang = aT.z * 6.2831 + aSize.z * age;
    vec2 q = (uv - 0.5);
    if (aT.w == 4.0 || aT.w == 2.0) {
      // sparks and spray stretch along their motion in screen space: streaks of light, jets of water
      vec3 vel = aV0 * exp(-aPhys.x * age) + vec3(0.0, -aPhys.y * age, 0.0);
      vec2 sv2 = (viewMatrix * vec4(vel, 0.0)).xy;
      vec2 dir = normalize(sv2 + vec2(0.0001));
      vec2 side = vec2(dir.y, -dir.x);
      float stretch = aT.w == 4.0 ? 4.0 : 1.0 + 1.6 * smoothstep(2.0, 25.0, length(sv2)) * (1.0 - k * 0.7);
      q = dir * q.y * stretch + side * q.x;
    } else {
      float c = cos(ang), s = sin(ang);
      q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    }
    // screen-up and the sun's screen direction, expressed in the sprite's own (rotated) uv frame
    vUpUv = vec2(sin(ang), cos(ang));
    vec3 sv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
    vSun3 = vec3(cos(ang) * sv.x + sin(ang) * sv.y, -sin(ang) * sv.x + cos(ang) * sv.y, sv.z);
    vHeat = aSize.w * exp(-age / 2.6);
    mv.xy += q * size;
    gl_Position = projectionMatrix * mv;
  }`

const fragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec4 uLightPos[2];
  uniform vec3 uLightColor[2];
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uAdditive;
  varying vec4 vColor;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vKind;
  varying vec3 vWorld;
  varying vec2 vUpUv;
  varying vec3 vSun3;
  varying float vShade;
  varying float vHeat;
  uniform sampler2D uAtlas;
  vec3 blackbody(float t) {
    return mix(mix(vec3(0.35, 0.02, 0.0), vec3(1.0, 0.32, 0.04), smoothstep(0.0, 0.45, t)), vec3(1.0, 0.86, 0.55), smoothstep(0.55, 1.0, t));
  }
  float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float nn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hh(i), hh(i + vec2(1, 0)), u.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { return nn(p) * 0.55 + nn(p * 2.1 + 3.1) * 0.28 + nn(p * 4.3 + 7.7) * 0.17; }
  void main() {
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q);
    if (r > 1.0) discard;
    float kind = vKind;
    vec3 col = vColor.rgb;
    float alpha = vColor.a;
    if (kind == 4.0) {
      // spark: hot core
      float core = exp(-r * r * 6.0);
      vec3 hot = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.8), core);
      gl_FragColor = vec4(hot * col * 4.0 * core * (1.0 - vAge), 1.0);
      return;
    }
    // one of four billow shapes from the atlas: density in b, surface normal in rg
    float tile = floor(vSeed * 3.999);
    vec2 tuv = (vUv * 0.94 + 0.03) * 0.5 + vec2(mod(tile, 2.0), floor(tile / 2.0)) * 0.5;
    vec4 tx = texture2D(uAtlas, tuv);
    float dens = tx.b;
    if (kind == 3.0 || kind == 5.0) {
      // fire: temperature falls with age; the billow gives it tongues
      float t = clamp(1.0 - vAge * 1.15 + (dens - 0.5) * 0.6, 0.0, 1.0);
      vec3 fire = blackbody(t);
      float a = smoothstep(0.12 + vAge * 0.4, 0.45 + vAge * 0.4, dens) * smoothstep(0.0, 0.08, vAge);
      if (kind == 5.0) { a = exp(-r * r * 3.0) * (1.0 - vAge); fire = col; }
      gl_FragColor = vec4(fire * col * a * 1.6, 1.0);
      return;
    }
    if (kind == 2.0) {
      // spray: soft streaky mist, not billows; bright and cool like water
      float l = dot(uAmbient + uSunColor, vec3(0.3333));
      float mist = exp(-r * r * 2.6) * (0.55 + 0.45 * smoothstep(0.1, 0.7, dens));
      float a = mist * alpha * smoothstep(0.0, 0.05, vAge) * (1.0 - smoothstep(0.45, 1.0, vAge));
      vec3 sc = vec3(0.86, 0.92, 0.97) * l * (0.75 + 0.25 * (1.0 - r));
      float distS = length(cameraPosition - vWorld);
      sc = mix(sc, uFogColor, clamp(1.0 - exp(-pow(uFogDensity * distS, 1.6)), 0.0, 0.85));
      if (a < 0.004) discard;
      gl_FragColor = vec4(sc, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }
    // matter: smoke, dust, cloud. Thins from its edges as it ages, lit by sun and sky through its normals
    float erode = mix(0.05, 0.5, smoothstep(0.3, 1.0, vAge));
    float shape = smoothstep(erode, erode + 0.5, dens);
    vec3 n = vec3(tx.rg * 2.0 - 1.0, 0.0);
    n.z = sqrt(max(0.0, 1.0 - dot(n.xy, n.xy)));
    float sunL = clamp(dot(n, vSun3) * 0.7 + 0.3, 0.0, 1.0);
    float skyL = clamp(dot(n.xy, vUpUv) * 0.5 + 0.5, 0.0, 1.0);
    float core = 1.0 - 0.35 * smoothstep(0.55, 1.0, dens);
    vec3 lit = col * (uAmbient * (0.22 + 0.78 * skyL) * core + uSunColor * pow(sunL, 1.4) * 1.35) * vShade;
    for (int i = 0; i < 2; i++) {
      vec4 L = uLightPos[i];
      if (L.w <= 0.0) continue;
      float d = distance(vWorld, L.xyz);
      float fall = 1.0 / (1.0 + d * d / (L.w * L.w));
      lit += uLightColor[i] * col * fall * (0.55 + 0.45 * (1.0 - skyL));
    }
    // incandescence deep inside young smoke
    lit += blackbody(vHeat) * vHeat * vHeat * (0.4 + 2.2 * dens);
    float fadeIn = smoothstep(0.0, kind == 2.0 ? 0.04 : 0.1, vAge);
    float fadeOut = 1.0 - smoothstep(kind == 6.0 ? 0.8 : 0.7, 1.0, vAge);
    float a = shape * alpha * fadeIn * fadeOut;
    if (kind == 2.0) {
      // spray is water: bright and cool, never tinted like dust
      float l = dot(uAmbient + uSunColor, vec3(0.3333));
      lit = mix(lit, vec3(0.86, 0.92, 0.97) * l * (0.55 + 0.45 * sunL), 0.6);
    }
    float dist = length(cameraPosition - vWorld);
    float fog = 1.0 - exp(-pow(uFogDensity * dist, 1.6));
    lit = mix(lit, uFogColor, clamp(fog, 0.0, 0.85));
    if (a < 0.004) discard;
    gl_FragColor = vec4(lit, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

/**
 * Four billow shapes in a 2x2 atlas: each a cluster of soft lobes eroded by noise. Density goes in blue, and the
 * density's gradient as a surface normal in red and green, so the shader can light every puff like a little sphere
 * cluster: bright on the sun side, dark in the folds.
 */
function puffAtlas(): THREE.DataTexture {
  const T = 256, S = T * 2
  const data = new Uint8Array(S * S * 4)
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const hash = (x: number, y: number) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v) }
  const noise = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
  const fbm = (x: number, y: number) => noise(x, y) * 0.5 + noise(x * 2.03 + 5.2, y * 2.03 + 1.3) * 0.28 + noise(x * 4.1 + 9.7, y * 4.1 + 3.1) * 0.14 + noise(x * 8.3 + 2.2, y * 8.3 + 7.9) * 0.08
  for (let tile = 0; tile < 4; tile++) {
    const lobes = Array.from({ length: 11 + tile * 2 }, () => {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * 0.5
      return { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.85 + 0.05, r: 0.17 + rnd() * 0.24, w: 0.6 + rnd() * 0.4 }
    })
    const field = new Float32Array(T * T)
    let max = 0
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const x = (i / (T - 1)) * 2 - 1, y = (j / (T - 1)) * 2 - 1
      let v = 0
      for (const l of lobes) { const dx = x - l.x, dy = y - l.y; v += l.w * Math.exp(-(dx * dx + dy * dy) / (l.r * l.r)) }
      v *= 0.62 + 0.75 * fbm(x * 3.2 + tile * 11, y * 3.2 + tile * 7)
      v *= 1 - smoothstep(0.82, 1, Math.hypot(x, y))
      field[j * T + i] = v
      if (v > max) max = v
    }
    const ox = (tile % 2) * T, oy = Math.floor(tile / 2) * T
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const d = field[j * T + i] / max
      const gx = (field[j * T + Math.min(T - 1, i + 1)] - field[j * T + Math.max(0, i - 1)]) / max
      const gy = (field[Math.min(T - 1, j + 1) * T + i] - field[Math.max(0, j - 1) * T + i]) / max
      let nx = -gx * 22, ny = -gy * 22
      const len = Math.hypot(nx, ny)
      if (len > 0.96) { nx *= 0.96 / len; ny *= 0.96 / len }
      const k = ((oy + j) * S + ox + i) * 4
      data[k] = Math.round((nx * 0.5 + 0.5) * 255)
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[k + 2] = Math.round(Math.min(1, d) * 255)
      data[k + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

class Pool {
  readonly mesh: THREE.Mesh
  readonly geo: THREE.InstancedBufferGeometry
  private cursor = 0
  private attrs: Record<string, THREE.InstancedBufferAttribute>
  private pending: [number, number][] = []

  constructor(readonly capacity: number, material: THREE.ShaderMaterial) {
    const geo = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geo.index = quad.index
    geo.setAttribute('position', quad.getAttribute('position'))
    geo.setAttribute('uv', quad.getAttribute('uv'))
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.attrs = { aP0: mk(3), aV0: mk(3), aT: mk(4), aSize: mk(4), aColor: mk(4), aPhys: mk(4), aOrbit: mk(4) }
    // everything starts dead
    const t = this.attrs.aT.array as Float32Array
    for (let i = 0; i < capacity; i++) { t[i * 4] = -1e9; t[i * 4 + 1] = 1 }
    for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a)
    // only draw as far into the pool as it has been filled
    geo.instanceCount = 0
    this.geo = geo
    this.mesh = new THREE.Mesh(geo, material)
    this.mesh.frustumCulled = false
  }

  emit(e: Emit, time: number) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    if (i + 1 > this.geo.instanceCount) this.geo.instanceCount = i + 1
    const A = this.attrs
    const set = (a: THREE.InstancedBufferAttribute, ...v: number[]) => (a.array as Float32Array).set(v, i * a.itemSize)
    set(A.aP0, e.x, e.y, e.z)
    set(A.aV0, e.vx ?? 0, e.vy ?? 0, e.vz ?? 0)
    set(A.aT, time + (e.delay ?? 0), e.life, random(), e.kind)
    set(A.aSize, e.size0, e.size1, e.spin ?? (random() - 0.5) * 0.4, e.heat ?? 0)
    set(A.aColor, e.r, e.g, e.b, e.a ?? 1)
    set(A.aPhys, e.drag ?? 0.5, e.gravity ?? 0, e.buoyancy ?? 0, e.turb ?? 0)
    set(A.aOrbit, e.orbit?.[0] ?? 0, e.orbit?.[1] ?? 0, e.orbit?.[2] ?? 0, e.orbit ? (e.rise ?? 1) : 0)
    const last = this.pending[this.pending.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else this.pending.push([i, i + 1])
  }

  flush() {
    if (!this.pending.length) return
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges()
      for (const [s, e] of this.pending) a.addUpdateRange(s * a.itemSize, (e - s) * a.itemSize)
      a.needsUpdate = true
    }
    this.pending = []
  }

  clear() {
    const t = this.attrs.aT.array as Float32Array
    for (let i = 0; i < this.capacity; i++) t[i * 4] = -1e9
    this.attrs.aT.clearUpdateRanges()
    this.attrs.aT.needsUpdate = true
    this.pending = []
  }
}

export class Particles {
  readonly matter: Pool
  readonly light: Pool
  readonly uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uAmbient: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uLightPos: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uLightColor: { value: [new THREE.Color(), new THREE.Color()] },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.0001 },
    uAdditive: { value: 0 },
    uAtlas: { value: puffAtlas() },
  }
  time = 0

  constructor(scene: THREE.Scene) {
    const common = { vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, transparent: true, depthWrite: false }
    this.matter = new Pool(60000, new THREE.ShaderMaterial({ ...common }))
    this.light = new Pool(40000, new THREE.ShaderMaterial({ ...common, blending: THREE.AdditiveBlending, toneMapped: false }))
    this.matter.mesh.renderOrder = 2
    this.light.mesh.renderOrder = 3
    scene.add(this.matter.mesh, this.light.mesh)
  }

  emit(e: Emit) {
    const pool = e.kind === Kind.Fire || e.kind === Kind.Spark || e.kind === Kind.Glow ? this.light : this.matter
    pool.emit(e, this.time)
  }

  update(time: number, _camera: THREE.Camera) {
    this.time = time
    this.uniforms.uTime.value = time
    this.matter.flush()
    this.light.flush()
  }

  clear() { this.matter.clear(); this.light.clear() }
}
