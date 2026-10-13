import * as THREE from 'three'

/** The fireball and mushroom cloud. (There is deliberately no shock ring or condensation dome: the blast reads through what it does.) */

const noise = /* glsl */ `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }`

export interface FireEnv {
  uSunDir: { value: THREE.Vector3 }
  uSunColor: { value: THREE.Color }
  uAmbient: { value: THREE.Color }
}

export interface FireOpts {
  /** rise height scale (1: a nuke's ~1.2 km) */
  rise?: number
  /** when the cloud starts and finishes melting away (s) */
  fade?: [number, number]
  /** soot darkness multiplier for the cooled cloud (1 normal) */
  tone?: number
}


let base: THREE.ShaderMaterial | null = null
/** One material kept alive for the life of the page, so its program is compiled once (see Fireball.warm). */
function baseMaterial() {
  return (base ??= fireMaterial())
}

function fireMaterial() {
return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color(1, 1, 1) }, uAmbient: { value: new THREE.Color(0.5, 0.5, 0.5) },
      uGlow: { value: new THREE.Vector4() },
      uGlowColor: { value: new THREE.Color(1.6, 0.55, 0.16) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0 },
      uTone: { value: 1 },
      uScale: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aHeat; // heat, seed, stem, -
      uniform float uTime;
      varying vec3 vW;
      varying vec3 vObj;
      varying float vHeat;
      varying float vSeed;
      varying vec3 vN;
      varying float vDisp;
      ${noise}
      void main() {
        vec3 p = position;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * position);
        float s = aHeat.y * 17.0;
        float n = snoise(p * 1.6 + s + vec3(0.0, -uTime * 0.5, 0.0)) * 0.55 + snoise(p * 3.4 + s * 1.3 + uTime * 0.35) * 0.25;
        p *= 1.0 + n * 0.34;
        vDisp = n;
        vObj = p;
        vHeat = aHeat.x;
        vSeed = aHeat.y;
        vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uAmbient;
      uniform vec4 uGlow;
      uniform vec3 uGlowColor;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uTone;
      uniform float uScale;
      varying vec3 vW;
      varying vec3 vObj;
      varying float vHeat;
      varying float vSeed;
      varying vec3 vN;
      varying float vDisp;
      ${noise}
      vec3 blackbody(float t) {
        vec3 c = mix(vec3(0.25, 0.02, 0.0), vec3(1.0, 0.3, 0.03), smoothstep(0.0, 0.4, t));
        c = mix(c, vec3(1.0, 0.68, 0.25), smoothstep(0.4, 0.75, t));
        return mix(c, vec3(1.0, 0.95, 0.85), smoothstep(0.75, 1.1, t));
      }
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 Nf = normalize(cross(dFdx(vW), dFdy(vW)));
        if (dot(Nf, V) < 0.0) Nf = -Nf;
        vec3 N = normalize(mix(normalize(vN), Nf, 0.55));
        // temperature varies across the whole fireball (world space), not in the same spots on every lobe
        vec3 wq = (vW - uGlow.xyz) / uScale;
        float sn = snoise(wq * 2.2 + vec3(0.0, -uTime * 0.5, 0.0)) * 0.5 + 0.5;
        float sn2 = snoise(wq * 5.5 + vObj * 0.6 + uTime * 0.4) * 0.5 + 0.5;
        float facing = max(dot(N, V), 0.0);
        // hot where the lobes bulge toward you, cooler in the folds and the soot veins
        float t = vHeat * (0.45 + 0.75 * sn * sn + 0.25 * sn2) * (0.6 + 0.4 * facing);
        vec3 fire = blackbody(t) * (0.8 + 3.4 * t * t);
        vec3 albedo = mix(vec3(0.05, 0.047, 0.045), vec3(0.2, 0.19, 0.18), sn * 0.7 + sn2 * 0.3) * uTone;
        float sun = max(dot(N, uSunDir), 0.0);
        vec3 lit = albedo * (uAmbient * (0.3 + 0.45 * (N.y * 0.5 + 0.5)) + uSunColor * pow(sun, 1.2) * 1.25);
        if (uGlow.w > 0.0) {
          vec3 L = uGlow.xyz - vW;
          float d = length(L);
          lit += albedo * uGlowColor * (0.35 + 0.65 * max(dot(N, L / d), 0.0)) * uGlow.w;
        }
        // the folds between lobes sit in shadow; the cloud keeps its relief
        lit *= 0.35 + 0.65 * smoothstep(-0.45, 0.35, vDisp);
        vec3 col = mix(lit, fire, smoothstep(0.06, 0.3, t));
        float dist = length(cameraPosition - vW);
        float fog = 1.0 - exp(-pow(uFogDensity * dist, 1.6));
        col = mix(col, uFogColor, clamp(fog, 0.0, 0.85));
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
}

interface Puff { th: number; phi: number; s: number; size: number; stem: number; u: number; phase: number; jitter: number }

/**
 * The fireball and the cloud it becomes: a few hundred lumpy, opaque puffs (noise-displaced, faceted spheres) that
 * boil as a white-hot ball, roll up into a toroidal cap and a stem, and cool from the outside in, so the glow shows
 * through the cracks between dark soot lobes. Puff positions are cheap CPU maths each frame; looks are in the shader.
 */
export class Fireball {
  readonly mesh = new THREE.Group()
  private puffs: THREE.InstancedMesh
  private mat: THREE.ShaderMaterial
  private heatAttr: THREE.InstancedBufferAttribute
  private list: Puff[] = []
  private scale = 0
  private m4 = new THREE.Matrix4()
  private fade: [number, number]
  private riseK: number

  constructor(private scene: THREE.Scene, private at: THREE.Vector3, private R: number, env: FireEnv, opts: FireOpts = {}) {
    this.fade = opts.fade ?? [45, 72]
    this.riseK = opts.rise ?? 1
    const N = 420
    // its own generator: the film recorder swaps Math.random for a short LCG whose consecutive draws are correlated
    let seed = (Math.random() * 2 ** 31) | 0 || 1
    const r = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let i = 0; i < N; i++) {
      const stem = i < N * 0.2 ? 1 : 0
      this.list.push({
        th: r() * Math.PI * 2,
        phi: Math.asin(r() * 2 - 1) + (r() < 0.5 ? 0 : Math.PI),
        s: stem ? Math.sqrt(r()) : 0.5 + 0.5 * Math.sqrt(r()),
        size: 0.15 + 0.27 * r() * r(),
        stem, u: r(), phase: r() * 6.28, jitter: 0.8 + 0.4 * r(),
      })
    }
    const geo = new THREE.IcosahedronGeometry(1, 3)
    this.mat = baseMaterial().clone()
    Object.assign(this.mat.uniforms, { uSunDir: env.uSunDir, uSunColor: env.uSunColor, uAmbient: env.uAmbient })
    this.mat.uniforms.uTone.value = opts.tone ?? 1
    this.heatAttr = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4)
    this.heatAttr.setUsage(THREE.DynamicDrawUsage)
    for (let i = 0; i < N; i++) this.heatAttr.setY(i, r())
    geo.setAttribute('aHeat', this.heatAttr)
    this.puffs = new THREE.InstancedMesh(geo, this.mat, N)
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.puffs.frustumCulled = false
    this.mesh.add(this.puffs)
    this.mesh.position.set(at.x, 0, at.z)
    scene.add(this.mesh)
  }

  /**
   * Keep an empty copy of the fireball in the scene from the start, so its shader is compiled (and stays compiled)
   * long before the first blast instead of stalling the first frame of it.
   */
  static warm(scene: THREE.Scene) {
    const geo = new THREE.IcosahedronGeometry(1, 1)
    geo.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(4), 4))
    const m = new THREE.InstancedMesh(geo, baseMaterial().clone(), 1)
    m.setMatrixAt(0, new THREE.Matrix4().makeScale(1e-4, 1e-4, 1e-4).setPosition(0, -1e4, 0))
    m.frustumCulled = false
    scene.add(m)
  }

  radius() { return this.scale }

  update(age: number, _dt: number) {
    const R = this.R
    const a = age
    const ss = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
    const Rg = R * (1 - Math.exp(-a * 6)) * (1 + 0.045 * Math.min(a, 14))
    this.scale = Rg
    const m = ss(1.2, 8, a)
    const rise = 1250 * (R / 230) * this.riseK * (1 - Math.exp(-a * 0.13))
    const cy = Math.max(Rg * 0.62, rise)
    this.mesh.position.set(this.at.x, cy, this.at.z)
    const Rcap = Rg * (1 + 0.9 * m)
    const ringR = m * Rcap * 0.55
    const tube = Rg + (Rcap * 0.48 - Rg) * m
    const melt = 1 - ss(this.fade[0], this.fade[1], a)
    const boil = 0.3 + 0.6 * Math.exp(-a * 0.45)
    const h = this.heatAttr.array as Float32Array
    const cool = 0.72 * Math.exp(-a * 0.3) + 0.55 * Math.exp(-a * 4)
    for (let i = 0; i < this.list.length; i++) {
      const p = this.list[i]
      let x: number, y: number, z: number, size: number, heat: number
      if (!p.stem) {
        const th = p.th + a * 0.03
        const phi = p.phi - a * boil
        const rad = p.s * tube
        const ring = ringR + Math.cos(phi) * rad
        x = Math.cos(th) * ring
        z = Math.sin(th) * ring
        y = Math.sin(phi) * rad * (1 - 0.32 * m)
        size = Rg * p.size * (1 + 0.45 * m) * (1 + 0.09 * Math.sin(a * 1.9 + p.phase))
        // the outside cools first; the core stays hot and glows through the gaps
        const inner = 0.8 * Math.exp(-a * 0.14)
        const outer = cool * (1.2 - 0.55 * ss(0.2, 2.2, a))
        const depth = Math.pow((p.s - 0.5) * 2, 0.6)
        // the underside of the rolling cap stays lit by the fire under it
        const under = Math.max(0, -Math.sin(phi)) * 0.25 * Math.exp(-a * 0.12) * m
        heat = (inner + (outer - inner) * depth + under) * p.jitter - 0.04 * m
      } else {
        const u = (p.u + a * 0.045) % 1
        const top = cy - Rcap * 0.25
        y = u * top - cy
        const w = Rg * (0.07 + 0.12 * u * u + 0.3 * (1 - u) ** 10) * p.s
        const th = p.th + a * 0.2
        x = Math.cos(th) * w
        z = Math.sin(th) * w
        size = Rg * (0.1 + 0.08 * u + 0.08 * (1 - u) ** 10) * p.jitter * ss(1.5, 5, a)
        heat = 0.22 * cool * (1 - u) ** 2 * p.jitter
      }
      size *= melt
      h[i * 4] = Math.max(0, heat)
      this.m4.makeScale(size, size * 0.92, size).setPosition(x, y, z)
      this.puffs.setMatrixAt(i, this.m4)
    }
    this.puffs.instanceMatrix.needsUpdate = true
    this.heatAttr.needsUpdate = true
    const u = this.mat.uniforms
    u.uTime.value = a
    u.uScale.value = Math.max(Rcap, 1)
    u.uGlow.value.set(this.at.x, cy - Rg * 0.2, this.at.z, 2.2 * Math.exp(-a * 0.2) + 0.25 * Math.exp(-a / 20))
    const fog = this.scene.fog as THREE.FogExp2 | null
    if (fog) { u.uFogColor.value.copy(fog.color); u.uFogDensity.value = fog.density }
    this.mesh.visible = melt > 0.002
  }

  dispose() {
    this.scene.remove(this.mesh)
    this.puffs.geometry.dispose()
    this.mat.dispose()
    this.puffs.dispose()
  }
}
