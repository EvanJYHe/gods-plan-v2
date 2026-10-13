import * as THREE from 'three'
import { WATER_GLSL, type WaterUniforms } from '../city/water'
import { DRY, type Flood } from './flood'

/** The flood's surface: a grid displaced in the vertex shader from float textures of the simulation, uploaded each
 * frame, shaded like the lake plus depth colour, light through steep faces and foam that rides the current. */

/** The flood surface sits at the static lake's height when at rest. */
const LIFT = 0.2

const vertex = /* glsl */ `
  uniform sampler2D uSim;
  uniform sampler2D uVel;
  uniform vec4 uGrid;   // x0, z0, cell, n
  uniform float uTime;
  varying vec3 vWorld;
  varying float vSteep;
  varying vec3 vNrm;
  varying float vDepth;
  varying float vFoam;
  varying vec2 vVel;
  varying float vEdge;
  varying float vCurv;
  float vh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(vh(i), vh(i + vec2(1, 0)), u.x), mix(vh(i + vec2(0, 1)), vh(i + vec2(1, 1)), u.x), u.y);
  }
  float eta(ivec2 c) {
    int n = int(uGrid.w);
    return texelFetch(uSim, clamp(c, ivec2(0), ivec2(n - 1)), 0).x;
  }
  void main() {
    ivec2 c = ivec2(position.xz);
    vec4 s = texelFetch(uSim, c, 0);
    vec2 vel = texelFetch(uVel, c, 0).xy;
    float cell = uGrid.z;
    float eR = eta(c + ivec2(1, 0)), eL = eta(c - ivec2(1, 0)), eD = eta(c + ivec2(0, 1)), eU = eta(c - ivec2(0, 1));
    float gx = eR - eL;
    float gz = eD - eU;
    // curvature: negative on a crest, positive at the toe of a face
    vCurv = clamp((eR + eL + eD + eU - 4.0 * s.x) / cell, -6.0, 6.0) * step(0.3, s.y);
    // keep wall-sized jumps out of the normal
    gx = clamp(gx, -3.0 * cell, 3.0 * cell);
    gz = clamp(gz, -3.0 * cell, 3.0 * cell);
    vNrm = normalize(vec3(-gx, 2.0 * cell, -gz));
    vDepth = s.y;
    vFoam = s.z;
    vVel = vel;
    float n = uGrid.w;
    vEdge = min(min(position.x, position.z), min(n - 1.0 - position.x, n - 1.0 - position.z));
    // a face one cell wide reads as a cliff (and as pointed tents between buildings): spread steep faces over
    // their neighbours so the water slumps forward instead of standing up
    float avg = (eR + eL + eD + eU + eta(c + ivec2(1, 1)) + eta(c + ivec2(-1, 1)) + eta(c + ivec2(1, -1)) + eta(c + ivec2(-1, -1))) / 8.0;
    float stp = clamp(length(vec2(gx, gz)) / (2.0 * cell), 0.0, 3.0);
    float e0 = mix(s.x, max(avg, s.x - s.y + 0.05), smoothstep(0.3, 1.2, stp) * 0.7 * step(0.05, s.y));
    vec3 w = vec3(uGrid.x + (position.x + 0.5) * cell, e0 + ${LIFT.toFixed(2)}, uGrid.y + (position.z + 0.5) * cell);
    // a breaking face tumbles: lumps of water heave up and lurch forward along it, churning as it runs
    float st = clamp(length(vec2(gx, gz)) / (2.0 * cell), 0.0, 3.0);
    float face = smoothstep(0.15, 0.9, st) * step(0.5, s.y);
    vSteep = face;
    // the churning water just behind a breaking front heaves too, so its top edge is torn, not a straight line
    float churnZone = max(face, smoothstep(0.6, 1.25, s.z) * smoothstep(1.0, 8.0, s.y));
    float sp = length(vel);
    vec2 fd = sp > 0.1 ? vel / sp : vec2(0.0);
    vec2 q = w.xz * 0.018 - vel * uTime * 0.012;
    float lump = vn(q + uTime * 0.35) * 0.65 + vn(q * 2.7 - uTime * 0.6) * 0.35 - 0.5;
    float hgt = min(s.y, 60.0);
    w.y += lump * churnZone * (1.5 + hgt * 0.15);
    w.xz += fd * face * (vn(q * 1.7 + 9.0 + uTime * 0.5) - 0.25) * (4.0 + hgt * 0.25);
    vWorld = w;
    gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
  }`

const fragment = /* glsl */ `
  ${WATER_GLSL}
  uniform float uFade;
  uniform vec3 uSunLight;
  uniform float uLight;
  varying vec3 vWorld;
  varying vec3 vNrm;
  varying float vDepth;
  varying float vFoam;
  varying vec2 vVel;
  varying float vEdge;
  varying float vCurv;
  varying float vSteep;
  float fbm(vec2 p) { return wn(p) * 0.5 + wn(p * 2.03 + 3.7) * 0.27 + wn(p * 4.1 + 1.3) * 0.15 + wn(p * 8.3 + 7.1) * 0.08; }
  /** foam texture dragged along the flow: two phases of a flow-map, streaked along the current */
  float flowFoam(vec2 p, vec2 vel, float scale) {
    float sp = length(vel);
    vec2 dir = sp > 0.01 ? vel / sp : vec2(1.0, 0.0);
    vec2 side = vec2(-dir.y, dir.x);
    float ph = uTime * 0.45;
    float t1 = fract(ph), t2 = fract(ph + 0.5);
    vec2 q1 = p - vel * t1 * 1.6, q2 = p - vel * t2 * 1.6 + 17.3;
    // stretch along the flow so fast water draws streaks
    float stretch = 1.0 / (1.0 + sp * 0.05);
    vec2 a1 = vec2(dot(q1, dir) * stretch, dot(q1, side)) * scale;
    vec2 a2 = vec2(dot(q2, dir) * stretch, dot(q2, side)) * scale;
    float w = abs(1.0 - 2.0 * t1);
    return mix(fbm(a1 + fbm(a1 * 0.7) * 0.55), fbm(a2 + fbm(a2 * 0.7) * 0.55), 1.0 - w);
  }
  void main() {
    if (vDepth < 0.06) discard;
    vec2 p = vWorld.xz;
    float sp = length(vVel);
    float deep = 1.0 - exp(-vDepth / 7.0);
    // ripples of the calm lake, rougher and finer where the flow is fast and turbulent
    vec2 rip = rippleSlope(p) * (1.0 + min(sp, 30.0) * 0.06);
    float chop = (fbm(p * 0.15 - vVel * uTime * 0.06) - 0.5) * min(sp / 25.0, 1.0);
    vec3 n = normalize(vNrm + vec3(rip.x + chop * 0.6, 0.0, rip.y - chop * 0.6) * 0.9);
    vec3 view = normalize(cameraPosition - vWorld);
    // body: the lake's deep blue-green, lighter and siltier where thin over the city, light passing through steep faces
    vec3 shallow = vec3(0.17, 0.3, 0.27);
    vec3 body = mix(shallow, uDeep, deep);
    float steep = 1.0 - vNrm.y;
    // light through the thin water near the very crest only, in patches
    float crestZone = smoothstep(0.3, 1.8, -vCurv);
    float patchy = smoothstep(0.45, 0.75, fbm(p * 0.035 + vec2(uTime * 0.05, 0.0)));
    float through = smoothstep(0.1, 0.5, steep) * crestZone * patchy * pow(max(dot(-view, uSunDir) * 0.5 + 0.5, 0.0), 2.0);
    body = mix(body, vec3(0.07, 0.3, 0.27), clamp(through * 0.9, 0.0, 0.6));
    // faces otherwise darken: a wall of churned water in shadow
    body *= 1.0 - 0.15 * smoothstep(0.15, 0.6, steep) * (1.0 - crestZone);
    vec3 col = shadeWater(vWorld, n, body, 1.0 - 0.35 * smoothstep(0.0, 1.0, vFoam));
    // foam: the simulated field shaped into streaks and patches that ride the current, at two scales
    float f = clamp(vFoam, 0.0, 1.5);
    float tex = mix(flowFoam(p, vVel, 0.05), flowFoam(p * 0.37 + 31.0, vVel * 0.37, 0.05), 0.45);
    float fine = flowFoam(p * 3.1 + 5.0, vVel * 3.1, 0.05);
    // big slow gaps of dark water break up the sheet so it never reads as one marbled texture
    vec2 drift = vVel * uTime * 0.25;
    float gaps = smoothstep(0.3, 0.62, fbm(p * 0.009 - drift * 0.009 + 3.0) * 0.7 + fbm(p * 0.031 - drift * 0.031) * 0.3);
    f *= mix(0.25, 1.15, gaps);
    // a breaking face churns white, torn into streaks running down it
    vec2 side = vec2(-vNrm.z, vNrm.x);
    float sl = length(side) > 0.01 ? dot(p, normalize(side)) : p.x;
    float streak = fbm(vec2(sl * 0.05, vWorld.y * 0.035 + uTime * 0.7) + fine * 0.35);
    float churn = max(vSteep, smoothstep(0.12, 0.4, steep));
    f = max(f, churn * smoothstep(0.45, 0.7, streak) * 0.9);
    float crest = crestZone * smoothstep(0.1, 0.4, steep + 0.2);
    float toe = smoothstep(0.6, 2.5, vCurv);
    f = max(f, max(crest, toe * 0.8) * (0.7 + 0.6 * fine));
    // patches with gaps of dark water between them, however churned the water is
    float cover = smoothstep(1.0 - min(f, 1.0) * 0.6, 1.12 - min(f, 1.0) * 0.6, tex + 0.22 * fine);
    cover = max(cover, churn * smoothstep(0.52, 0.66, streak) * 0.9);
    // a thin lace of bubbles between the patches
    cover = max(cover, smoothstep(0.64, 0.72, fine) * smoothstep(0.05, 0.45, f) * 0.45);
    float lit = clamp(dot(n, uSunDir) * 0.6 + 0.45, 0.0, 1.0);
    // foam: cool grey-blue in shade, warm white where the sun catches it
    vec3 foamCol = mix(vec3(0.5, 0.57, 0.64), vec3(0.9, 0.92, 0.93), lit) * (0.55 + 0.25 * fine) + uSunLight * 0.16 * lit;
    foamCol *= 1.0 - 0.75 * uNight;
    col = mix(col, foamCol, clamp(cover, 0.0, 1.0) * 0.95);
    col *= uLight;
    gl_FragColor = vec4(waterFog(col, vWorld), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`

/** The flood's surface mesh and the textures it reads. */
export class FloodSurface {
  readonly mesh: THREE.Mesh
  private sim: Float32Array
  private vel: Float32Array
  private simTex: THREE.DataTexture
  private velTex: THREE.DataTexture
  private mat: THREE.ShaderMaterial
  private geo: THREE.BufferGeometry

  constructor(private f: Flood, water: WaterUniforms) {
    const n = f.n
    this.sim = new Float32Array(n * n * 4)
    this.vel = new Float32Array(n * n * 2)
    this.simTex = new THREE.DataTexture(this.sim, n, n, THREE.RGBAFormat, THREE.FloatType)
    this.velTex = new THREE.DataTexture(this.vel, n, n, THREE.RGFormat, THREE.FloatType)
    for (const t of [this.simTex, this.velTex]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false }
    const pos = new Float32Array(n * n * 3)
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = (j * n + i) * 3; pos[k] = i; pos[k + 2] = j }
    const idx = new Uint32Array((n - 1) * (n - 1) * 6)
    let q = 0
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1
      idx[q++] = a; idx[q++] = c; idx[q++] = b
      idx[q++] = b; idx[q++] = c; idx[q++] = d
    }
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1))
    this.mat = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        ...water,
        uSim: { value: this.simTex },
        uVel: { value: this.velTex },
        uGrid: { value: new THREE.Vector4(f.x0, f.z0, f.cell, n) },
        uFade: { value: 1 },
        uSunLight: { value: new THREE.Color(1, 1, 1) },
        uLight: { value: 1 },
      },
    })
    this.mesh = new THREE.Mesh(this.geo, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.upload(true)
  }

  light(v: number, sunColor: THREE.Color) {
    this.mat.uniforms.uLight.value = v
    this.mat.uniforms.uSunLight.value.copy(sunColor)
  }

  /** Copy the simulation into the textures (only the active area unless `all`). */
  upload(all = false) {
    const f = this.f, n = f.n, h = f.h, b = f.b, foam = f.foam, sim = this.sim, vel = this.vel
    const n1 = n + 1
    const I0 = all ? 0 : Math.max(0, f.i0 - 3), I1 = all ? n - 1 : Math.min(n - 1, f.i1 + 3)
    const J0 = all ? 0 : Math.max(0, f.j0 - 3), J1 = all ? n - 1 : Math.min(n - 1, f.j1 + 3)
    if (I1 < I0) return
    for (let j = J0; j <= J1; j++) {
      for (let i = I0; i <= I1; i++) {
        const c = j * n + i
        const hh = h[c]
        let e: number
        if (hh > DRY) e = b[c] + hh
        else {
          // dry: next to water, the surface stays level up to a wall, or runs down to the ground at a front
          let s = 0, m = 0
          if (i > 0 && h[c - 1] > DRY) { s += b[c - 1] + h[c - 1]; m++ }
          if (i < n - 1 && h[c + 1] > DRY) { s += b[c + 1] + h[c + 1]; m++ }
          if (j > 0 && h[c - n] > DRY) { s += b[c - n] + h[c - n]; m++ }
          if (j < n - 1 && h[c + n] > DRY) { s += b[c + n] + h[c + n]; m++ }
          if (m) { s /= m; e = b[c] > s ? s : b[c] } else e = Math.min(b[c], 0.3) - 0.5
        }
        const q = c * 4
        sim[q] = e
        sim[q + 1] = hh
        sim[q + 2] = foam[c]
        vel[c * 2] = 0.5 * (f.u[j * n1 + i] + f.u[j * n1 + i + 1])
        vel[c * 2 + 1] = 0.5 * (f.v[c] + f.v[c + n])
      }
    }
    this.simTex.needsUpdate = true
    this.velTex.needsUpdate = true
  }

  dispose() {
    this.mesh.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
    this.simTex.dispose()
    this.velTex.dispose()
  }
}
