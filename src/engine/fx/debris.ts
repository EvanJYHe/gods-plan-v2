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
 * Chunks of building thrown by blasts and waves: instanced boxes on analytic ballistic arcs that tumble, hit the
 * ground (or the rubble already there), bounce once, slide to rest and stay, so ruins pile up. The CPU keeps a coarse
 * rubble height map: each chunk's landing point is known when it's emitted, so it is given the pile height there as
 * its floor and then raises the pile. Hot chunks glow and cool. All motion is in the vertex shader.
 */

export interface Chunk {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  sx: number; sy: number; sz: number
  r: number; g: number; b: number
  /** seconds; Infinity (or anything over 1e5) stays until rebuild */
  life?: number
  hot?: number
  delay?: number
  /** low gravity for things carried by water */
  float?: number
  /** 1: painted with the building's windows on its sides */
  facade?: number
  /** land on the rubble pile and add to it */
  pile?: boolean
}

const G = 22

const vertex = /* glsl */ `
  attribute vec3 aP0;
  attribute vec3 aV0;
  attribute vec4 aT;     // t0, life, seed, hot
  attribute vec3 aScale;
  attribute vec4 aColor; // rgb, float (0..1: how buoyant)
  attribute vec4 aSpin;  // axis, speed
  attribute vec2 aExtra; // floor height, facade
  uniform float uTime;
  uniform float uSinkT;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vHot;
  varying vec3 vWorld;
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying float vFacade;
  varying float vSeed;
  varying float vGround;
  vec3 rot(vec3 p, vec3 a, float t) { float c = cos(t), s = sin(t); return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c); }
  void main() {
    float age = uTime - aT.x;
    float sinkAge = aT.x < uSinkT ? uTime - uSinkT : -1.0;
    if (age < 0.0 || age > aT.y || sinkAge > 1.4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float buoy = aColor.a;
    float g = mix(${G.toFixed(1)}, 3.0, buoy);
    vec3 v = aV0;
    float rest = aScale.y * 0.42 + aExtra.x;
    float y0 = aP0.y - rest;
    float th = (v.y + sqrt(max(v.y * v.y + 2.0 * g * max(y0, 0.0), 0.0))) / g;
    vec3 p;
    float spinT;
    float landed = 0.0;
    if (age < th) {
      p = aP0 + v * age + vec3(0.0, -0.5 * g * age * age, 0.0);
      spinT = age;
    } else {
      float tau = age - th;
      vec3 hit = aP0 + v * th + vec3(0.0, -0.5 * g * th * th, 0.0);
      float fr = mix(3.5, 0.4, buoy);
      vec2 vh = v.xz * mix(0.35, 0.9, buoy);
      float slide = (1.0 - exp(-tau * fr)) / fr;
      float vb = abs(v.y - g * th) * 0.22 * (1.0 - buoy);
      float by = max(0.0, vb * tau - 0.5 * g * tau * tau);
      p = vec3(hit.x + vh.x * slide, rest + by, hit.z + vh.y * slide);
      // the tumble dies in the bounce and the slide
      spinT = th + (1.0 - exp(-tau * 2.5)) * 0.25;
      landed = 1.0;
    }
    // things with a finite life sink away at the end of it; everything sinks on rebuild
    float k = age / aT.y;
    if (aT.y < 1e5) p.y -= smoothstep(0.85, 1.0, k) * aScale.y * 1.5;
    if (sinkAge > 0.0) p.y -= sinkAge * sinkAge * (aScale.y + aExtra.x + 2.0);
    vec3 axis = normalize(aSpin.xyz + vec3(0.0001));
    float ang = aSpin.w * spinT + aT.z * 6.28;
    vLocal = position * aScale;
    vLocalN = normal;
    vec3 local = rot(vLocal, axis, ang);
    vNormal = rot(normal, axis, ang);
    vColor = aColor.rgb;
    vHot = aT.w * exp(-age * 0.3);
    vFacade = aExtra.y;
    vSeed = aT.z;
    vec4 w = vec4(p + local, 1.0);
    vWorld = w.xyz;
    // settled chunks sit in each other's shadow
    vGround = landed * (1.0 - smoothstep(0.0, aScale.y * 1.2 + 1.0, w.y - aExtra.x));
    gl_Position = projectionMatrix * viewMatrix * w;
  }`

const fragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSky;
  uniform vec3 uGround;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform vec4 uFire;      // fireball position, reach
  uniform vec3 uFireColor;
  varying vec3 vNormal;
  varying vec3 vColor;
  varying float vHot;
  varying vec3 vWorld;
  varying vec3 vLocal;
  varying vec3 vLocalN;
  varying float vFacade;
  varying float vSeed;
  varying float vGround;
  float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec3 n = normalize(vNormal);
    vec3 base = vColor;
    // a piece of facade keeps its windows; broken faces are bare concrete
    if (vFacade > 0.5) {
      vec3 an = abs(vLocalN);
      if (an.y < 0.5) {
        vec2 uv = vec2(an.x > 0.5 ? vLocal.z : vLocal.x, vLocal.y) / vec2(3.0, 3.6) + vSeed * 7.0;
        vec2 f = fract(uv);
        float w = step(0.18, f.x) * step(f.x, 0.82) * step(0.22, f.y) * step(f.y, 0.78);
        float broken = step(0.55, hh(floor(uv) + vSeed));
        base = mix(base, base * vec3(0.45, 0.48, 0.52) * (broken > 0.5 ? 0.5 : 1.0), w * 0.75);
        if (vLocalN.x + vLocalN.z < 0.0) base = vec3(0.45, 0.43, 0.4) * (0.8 + 0.3 * hh(vec2(vSeed, 3.0)));
      } else {
        base = vec3(0.47, 0.45, 0.42) * (0.75 + 0.3 * hh(floor(vLocal.xz * 0.8) + vSeed));
      }
    }
    float sun = max(dot(n, uSunDir), 0.0);
    vec3 amb = mix(uGround, uSky, n.y * 0.5 + 0.5);
    float ao = 1.0 - 0.35 * vGround;
    vec3 col = base * (amb * 0.95 * ao + uSunColor * sun * 0.75 * (1.0 - 0.3 * vGround));
    if (uFire.w > 0.0) {
      vec3 L = uFire.xyz - vWorld;
      float d = length(L);
      col += base * uFireColor * max(dot(n, L / d), 0.0) / (1.0 + d * d / (uFire.w * uFire.w));
    }
    col += vec3(1.0, 0.35, 0.06) * vHot * 3.0;
    float dist = length(cameraPosition - vWorld);
    float fog = 1.0 - exp(-pow(uFogDensity * dist, 1.6));
    col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

const CELL = 3

export class Debris {
  readonly mesh: THREE.Mesh
  readonly capacity = 110000
  readonly uniforms = {
    uTime: { value: 0 },
    uSinkT: { value: -1e9 },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSky: { value: new THREE.Color(0.6, 0.65, 0.7) },
    uGround: { value: new THREE.Color(0.3, 0.3, 0.28) },
    uFogColor: { value: new THREE.Color() },
    uFogDensity: { value: 0.0001 },
    uFire: { value: new THREE.Vector4() },
    uFireColor: { value: new THREE.Color() },
  }
  private cursor = 0
  private attrs: Record<string, THREE.InstancedBufferAttribute>
  private pending: [number, number][] = []
  private time = 0
  private fullUpload = false
  private later = new Map<number, Chunk[]>()
  private sinkDone = 0
  private geo: THREE.InstancedBufferGeometry
  /** rubble pile height by 3 m cell */
  private heights = new Map<number, number>()

  constructor(scene: THREE.Scene) {
    const box = new THREE.BoxGeometry(1, 1, 1)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = box.index
    geo.setAttribute('position', box.getAttribute('position'))
    geo.setAttribute('normal', box.getAttribute('normal'))
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * n), n)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.attrs = { aP0: mk(3), aV0: mk(3), aT: mk(4), aScale: mk(3), aColor: mk(4), aSpin: mk(4), aExtra: mk(2) }
    const t = this.attrs.aT.array as Float32Array
    for (let i = 0; i < this.capacity; i++) { t[i * 4] = -1e9; t[i * 4 + 1] = 1 }
    for (const [k, a] of Object.entries(this.attrs)) geo.setAttribute(k, a)
    // only draw as far into the pool as it has been filled
    geo.instanceCount = 0
    this.geo = geo
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms }))
    this.mesh.frustumCulled = false
    scene.add(this.mesh)
  }

  private key(x: number, z: number) { return (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768) }

  /** Where a chunk thrown like this comes to rest (same arc as the shader, flat ground). */
  private landing(c: Chunk) {
    const rest = c.sy * 0.42
    const y0 = Math.max(c.y - rest, 0)
    const th = (c.vy + Math.sqrt(c.vy * c.vy + 2 * G * y0)) / G
    const k = th + 0.35 / 3.5
    return [c.x + c.vx * k, c.z + c.vz * k]
  }

  /**
   * Chunks due more than a few frames from now wait in time buckets and are written when they're due, so a blast that
   * throws fifty thousand of them spreads the work (and the pile bookkeeping happens in the order they land).
   */
  emit(c: Chunk) {
    const d = c.delay ?? 0
    if (d > 0.12) {
      const at = this.time + d
      const key = Math.floor(at * 10)
      let list = this.later.get(key)
      if (!list) this.later.set(key, (list = []))
      c.delay = at
      list.push(c)
      return
    }
    this.write(c)
  }

  private write(c: Chunk) {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % this.capacity
    if (i + 1 > this.geo.instanceCount) this.geo.instanceCount = i + 1
    const A = this.attrs
    const set = (a: THREE.InstancedBufferAttribute, ...v: number[]) => (a.array as Float32Array).set(v, i * a.itemSize)
    let floor = 0
    if (c.pile && !c.float) {
      const [lx, lz] = this.landing(c)
      const key = this.key(lx, lz)
      floor = this.heights.get(key) ?? 0
      // spread the chunk's volume over its cell and the neighbours, so mounds grow rather than columns
      const add = Math.min(2.5, (c.sx * c.sy * c.sz * 0.55) / (CELL * CELL * 2.2))
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const k = key + dx * 65536 + dz
        const w = dx === 0 && dz === 0 ? 1 : 0.35
        this.heights.set(k, Math.min(28, (this.heights.get(k) ?? 0) + add * w))
      }
    }
    const life = c.life === undefined ? 18 + random() * 10 : Math.min(c.life, 1e6)
    set(A.aP0, c.x, c.y, c.z)
    set(A.aV0, c.vx, c.vy, c.vz)
    set(A.aT, this.time + (c.delay ?? 0), life, random(), c.hot ?? 0)
    set(A.aScale, c.sx, c.sy, c.sz)
    set(A.aColor, c.r, c.g, c.b, c.float ?? 0)
    set(A.aSpin, random() - 0.5, random() - 0.5, random() - 0.5, (random() - 0.5) * 9)
    set(A.aExtra, floor, c.facade ?? 0)
    const last = this.pending[this.pending.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else this.pending.push([i, i + 1])
  }

  update(time: number) {
    this.time = time
    this.uniforms.uTime.value = time
    if (this.later.size) {
      const now = Math.floor(time * 10) + 1
      for (const [key, list] of this.later) {
        if (key > now) continue
        for (const c of list) { c.delay = Math.max(0, (c.delay ?? 0) - time); this.write(c) }
        this.later.delete(key)
      }
    }
    // once the rebuild has sunk everything, start the pool over
    if (this.sinkDone && time > this.sinkDone) {
      this.sinkDone = 0
      if (this.cursor === 0) this.geo.instanceCount = 0
    }
    if (this.fullUpload) {
      for (const a of Object.values(this.attrs)) { a.clearUpdateRanges(); a.needsUpdate = true }
      this.fullUpload = false
      this.pending = []
      return
    }
    if (!this.pending.length) return
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges()
      for (const [s, e] of this.pending) a.addUpdateRange(s * a.itemSize, (e - s) * a.itemSize)
      a.needsUpdate = true
    }
    this.pending = []
  }

  /** Everything on the ground sinks away (over about a second) and the piles are forgotten. */
  clear() {
    this.uniforms.uSinkT.value = this.time
    this.heights.clear()
    // chunks still waiting to be thrown never will be
    this.later.clear()
    const t = this.attrs.aT.array as Float32Array
    let any = false
    for (let i = 0; i < this.capacity; i++) if (t[i * 4] > this.time) { t[i * 4] = -1e9; any = true }
    if (any) this.fullUpload = true
    this.cursor = 0
    this.sinkDone = this.time + 1.5
  }
}
