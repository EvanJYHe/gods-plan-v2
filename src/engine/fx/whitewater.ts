import * as THREE from 'three'
import type { WaterUniforms } from '../city/water'

/**
 * Whitewater thrown out of the flood: torn sheets and jets of spray that rise, stretch along their flight and fall
 * back, plus soft mist. GPU particles (motion computed in the shader from launch state), lit like foam: bright on the
 * sun side, cool blue-grey in shade.
 */

const MAX = 12000

export interface Splash {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  life: number
  size0: number; size1: number
  /** 0 = torn sheet/jet (stretches, falls), 1 = mist (soft, drifts) */
  mist?: number
  alpha?: number
  gravity?: number
  drag?: number
  delay?: number
}

const vertex = /* glsl */ `
  attribute vec3 aP0;
  attribute vec3 aV0;
  attribute vec4 aT;     // t0, life, seed, mist
  attribute vec4 aS;     // size0, size1, alpha, gravity
  attribute float aDrag;
  uniform float uTime;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vMist;
  varying float vAlpha;
  varying vec3 vWorld;
  varying float vStretch;
  void main() {
    float age = uTime - aT.x;
    float k = age / aT.y;
    if (age < 0.0 || k > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float d = aDrag;
    float m = d > 0.0 ? (1.0 - exp(-d * age)) / d : age;
    vec3 p = aP0 + aV0 * m - vec3(0.0, 0.5 * aS.w * age * age, 0.0);
    p.y = max(p.y, 0.5);
    vec3 vel = aV0 * exp(-d * age) - vec3(0.0, aS.w * age, 0.0);
    float size = mix(aS.x, aS.y, sqrt(k));
    vec4 mv = viewMatrix * vec4(p, 1.0);
    vec2 q = uv - 0.5;
    // sheets stretch along their screen motion
    vec2 sv = (viewMatrix * vec4(vel, 0.0)).xy;
    float sl = length(sv);
    vec2 dir = normalize(sv + vec2(0.0001, 0.0002));
    vec2 side = vec2(dir.y, -dir.x);
    float stretch = 1.0 + (1.0 - aT.w) * 1.8 * smoothstep(3.0, 30.0, sl);
    vStretch = stretch;
    mv.xy += (dir * q.y * stretch + side * q.x) * size;
    gl_Position = projectionMatrix * mv;
    vUv = uv;
    vAge = k;
    vSeed = aT.z;
    vMist = aT.w;
    vAlpha = aS.z;
    vWorld = p;
  }`

const fragment = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uNight;
  uniform float uLight;
  varying vec2 vUv;
  varying float vAge;
  varying float vSeed;
  varying float vMist;
  varying float vAlpha;
  varying vec3 vWorld;
  varying float vStretch;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) { return n(p) * 0.5 + n(p * 2.1 + 3.1) * 0.3 + n(p * 4.3 + 7.7) * 0.2; }
  void main() {
    vec2 q = vUv - 0.5;
    float r = length(q) * 2.0;
    vec2 o = vec2(vSeed * 37.0, vSeed * 91.0);
    // torn: a noisy blob that breaks into strands and droplets as it ages
    float tex = fbm(q * vec2(5.0, 5.0 / vStretch) * 1.4 + o + vAge * 1.5);
    float edge = 1.0 - smoothstep(0.35, 1.0, r);
    float sheet = smoothstep(0.35 + vAge * 0.35, 0.6 + vAge * 0.3, tex * edge + edge * 0.25);
    float mist = exp(-r * r * 2.5) * (0.6 + 0.4 * tex);
    float a = mix(sheet, mist, vMist) * vAlpha;
    a *= smoothstep(0.0, 0.06, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
    if (a < 0.01) discard;
    // lit like foam: a pseudo-normal from the blob, bright toward the sun, cool grey in shade
    vec3 nrm = normalize(vec3(q.x * 2.0, 0.6 + q.y, 0.5));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float sunFacing = clamp(dot(uSunDir, normalize(viewDir + vec3(0.0, 0.3, 0.0))) * -0.5 + 0.5, 0.0, 1.0);
    float lit = clamp(0.35 + 0.65 * (tex * 0.6 + 0.4) * (0.4 + 0.6 * sunFacing) + nrm.y * 0.15, 0.0, 1.0);
    vec3 shade = vec3(0.56, 0.62, 0.68) * (0.6 + 0.4 * uSkyColor.b);
    vec3 bright = vec3(0.95, 0.96, 0.97) + uSunColor * 0.12;
    vec3 col = mix(shade, bright, lit) * (1.0 - 0.75 * uNight) * uLight;
    float dist = length(cameraPosition - vWorld);
    col = mix(col, uFogColor, clamp(1.0 - exp(-pow(uFogDensity * dist, 1.6)), 0.0, 0.85));
    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

export class Whitewater {
  readonly mesh: THREE.Mesh
  private geo: THREE.InstancedBufferGeometry
  private p0: THREE.InstancedBufferAttribute
  private v0: THREE.InstancedBufferAttribute
  private t: THREE.InstancedBufferAttribute
  private s: THREE.InstancedBufferAttribute
  private drag: THREE.InstancedBufferAttribute
  private next = 0
  private dirty = false
  private uniforms: Record<string, THREE.IUniform>

  constructor(scene: THREE.Scene, water: WaterUniforms) {
    const quad = new THREE.PlaneGeometry(1, 1)
    this.geo = new THREE.InstancedBufferGeometry()
    this.geo.index = quad.index
    this.geo.setAttribute('position', quad.getAttribute('position'))
    this.geo.setAttribute('uv', quad.getAttribute('uv'))
    const mk = (size: number) => new THREE.InstancedBufferAttribute(new Float32Array(MAX * size), size).setUsage(THREE.DynamicDrawUsage)
    this.p0 = mk(3); this.v0 = mk(3); this.t = mk(4); this.s = mk(4); this.drag = mk(1)
    // everything starts long dead
    for (let i = 0; i < MAX; i++) { this.t.array[i * 4] = -1e6; this.t.array[i * 4 + 1] = 1 }
    this.geo.setAttribute('aP0', this.p0)
    this.geo.setAttribute('aV0', this.v0)
    this.geo.setAttribute('aT', this.t)
    this.geo.setAttribute('aS', this.s)
    this.geo.setAttribute('aDrag', this.drag)
    this.geo.instanceCount = MAX
    this.uniforms = {
      uTime: { value: 0 },
      uSunDir: water.uSunDir, uSunColor: water.uSunColor, uSkyColor: water.uSkyColor,
      uFogColor: water.uFogColor, uFogDensity: water.uFogDensity, uNight: water.uNight,
      uLight: { value: 1 },
    }
    const mat = new THREE.ShaderMaterial({ vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide })
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
    scene.add(this.mesh)
  }

  emit(e: Splash, time: number) {
    const i = this.next
    this.next = (this.next + 1) % MAX
    const P = this.p0.array as Float32Array, V = this.v0.array as Float32Array, T = this.t.array as Float32Array, S = this.s.array as Float32Array
    P[i * 3] = e.x; P[i * 3 + 1] = e.y; P[i * 3 + 2] = e.z
    V[i * 3] = e.vx; V[i * 3 + 1] = e.vy; V[i * 3 + 2] = e.vz
    T[i * 4] = time + (e.delay ?? 0); T[i * 4 + 1] = e.life; T[i * 4 + 2] = Math.random(); T[i * 4 + 3] = e.mist ?? 0
    S[i * 4] = e.size0; S[i * 4 + 1] = e.size1; S[i * 4 + 2] = e.alpha ?? 0.9; S[i * 4 + 3] = e.gravity ?? 14
    ;(this.drag.array as Float32Array)[i] = e.drag ?? 0.3
    this.dirty = true
  }

  update(time: number, light: number) {
    this.uniforms.uTime.value = time
    this.uniforms.uLight.value = light
    if (this.dirty) {
      for (const a of [this.p0, this.v0, this.t, this.s, this.drag]) a.needsUpdate = true
      this.dirty = false
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.geo.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
