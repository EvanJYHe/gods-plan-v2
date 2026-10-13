import * as THREE from 'three'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import type { Engine } from '../engine'

/**
 * The final lens: a short exposure kick for the flash (never a white-out), a touch of chromatic fringing on big hits,
 * a gentle grade, a soft vignette and film grain. There are deliberately no shockwave refraction rings: the blast
 * reads through the dust, debris and breaking buildings it leaves behind.
 */

/** Kept for the engine's `shocks` list (no longer drawn). */
export interface Shock { x: number; z: number; r: number; strength: number; width: number }

const shader = {
  uniforms: {
    tDiffuse: { value: null },
    uFlash: { value: new THREE.Vector4(1, 1, 1, 0) },
    uAberration: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uVignette: { value: 0.32 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec4 uFlash;
    uniform float uAberration;
    uniform float uTime;
    uniform float uAspect;
    uniform float uVignette;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 ca = (uv - 0.5) * uAberration * 0.006;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - ca).b;
      // the flash: the exposure jumps and the frame warms; the image stays readable
      col *= 1.0 + uFlash.rgb * uFlash.a * 1.6;
      col += uFlash.rgb * uFlash.a * uFlash.a * 0.25;
      // a gentle grade: cool shadows, warm highlights
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col *= mix(vec3(0.94, 0.98, 1.06), vec3(1.04, 1.0, 0.95), smoothstep(0.05, 0.6, lum));
      col = max(mix(vec3(lum), col, 1.14), 0.0);
      vec2 v = (vUv - 0.5) * vec2(uAspect, 1.0);
      col *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(v));
      col += (hash(vUv * 731.0 + fract(uTime * 13.0)) - 0.5) * 0.018;
      gl_FragColor = vec4(col, 1.0);
    }`,
}

export class LensPass extends ShaderPass {
  constructor() {
    super(shader)
  }

  update(engine: Engine, dt: number) {
    const u = this.uniforms as typeof shader.uniforms
    u.uTime.value += dt
    const size = engine.renderer.getSize(new THREE.Vector2())
    u.uAspect.value = size.x / size.y
    u.uFlash.value.set(engine.flash.color.r, engine.flash.color.g, engine.flash.color.b, engine.flash.value)
    u.uAberration.value = engine.flash.value + engine.heat.value * 0.5
  }
}
