import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { loadCity, type CityData } from './data'
import { Buildings } from './city/buildings'
import { buildGround, groundUniforms, type GroundUniforms } from './city/ground'
import { buildWater, waterUniforms, type WaterUniforms } from './city/water'
import { Atmosphere, type TimeOfDay } from './city/atmosphere'
import { applyLandmark, loadLandmarks, resetLandmark, type Landmark } from './city/landmarks'
import { CameraRig } from './camera/rig'
import { Traffic } from './city/traffic'
import { Particles } from './fx/particles'
import { Debris } from './fx/debris'
import { LensPass, type Shock } from './fx/lens'
import { Sound } from './fx/sound'
import { Disasters, type Power } from './fx/disasters'

export type { Power } from './fx/disasters'

export interface EngineEvents {
  onProgress?: (p: number, label: string) => void
  onReady?: () => void
  onBusy?: (busy: boolean) => void
  /** awaited between the heavy build stages, so a host can keep them off its own busy moments */
  yieldTo?: () => Promise<void>
}

/** The whole simulator: renderer, city, camera, effects and the disasters, behind a small API for the UI. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly rig: CameraRig
  data!: CityData
  buildings!: Buildings
  landmarks: Landmark[] = []
  atmosphere!: Atmosphere
  traffic!: Traffic
  particles!: Particles
  debris!: Debris
  disasters!: Disasters
  readonly sound = new Sound()
  readonly ground: GroundUniforms = groundUniforms()
  readonly water: WaterUniforms = waterUniforms()
  readonly clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.05)
  readonly shocks: Shock[] = []
  readonly flash = { value: 0, color: new THREE.Color(1, 0.95, 0.85) }
  readonly heat = { value: 0 }
  timeScale = 1
  time = 0
  power: Power | null = null
  private composer!: EffectComposer
  private bloom!: UnrealBloomPass
  private lens!: LensPass
  private raf = 0
  private last = performance.now()
  private disposed = false
  private hoverPoint: THREE.Vector3 | null = null
  readonly reticle: THREE.Mesh
  frames = 0
  fps = 60

  constructor(private host: HTMLElement, readonly events: EngineEvents = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, reversedDepthBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.localClippingEnabled = true
    host.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'
    this.rig = new CameraRig(this.renderer.domElement)
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 128),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, depthTest: false, fog: false }),
    )
    this.reticle.rotation.x = -Math.PI / 2
    this.reticle.renderOrder = 10
    this.reticle.visible = false
    this.scene.add(this.reticle)
  }

  async load() {
    const progress = this.events.onProgress ?? (() => {})
    const pause = this.events.yieldTo ?? (() => new Promise<void>(r => setTimeout(r, 16)))
    progress(0.02, 'Downloading Toronto')
    this.data = await loadCity(p => progress(0.02 + p * 0.6, 'Downloading Toronto'))
    if (this.disposed) return
    progress(0.64, 'Raising the skyline')
    await pause()
    this.atmosphere = new Atmosphere(this.scene, this.renderer)
    this.scene.add(buildGround(this.data, this.ground))
    await pause()
    this.scene.add(buildWater(this.data, this.water))
    await pause()
    this.buildings = new Buildings(this.data)
    this.scene.add(this.buildings.mesh)
    progress(0.82, 'Placing landmarks')
    this.landmarks = await loadLandmarks(this.data, this.scene, this.clip)
    if (this.disposed) return
    progress(0.92, 'Waking the city')
    await pause()
    this.traffic = new Traffic(this.data, this.scene)
    this.particles = new Particles(this.scene)
    this.debris = new Debris(this.scene)
    this.disasters = new Disasters(this)
    const [b0, b1, b2, b3] = this.data.bounds
    this.rig.bounds = { minX: b0 + 200, maxX: b2 - 200, minZ: -b3 + 200, maxZ: -b1 - 200 }
    // the raw polygons are baked into meshes now; let the garbage collector have them
    this.data.surfaces = {}
    this.data.buildings = []
    this.data.massing = []
    this.data.farWater = []
    this.setupComposer()
    this.rig.onTap = (ndc, e) => this.tap(ndc, e)
    this.rig.onHover = ndc => { this.hoverPoint = ndc ? this.rig.ground(ndc) : null }
    window.addEventListener('resize', this.resize)
    this.resize()
    this.setTimeOfDay('golden')
    // compile every program in parallel (KHR_parallel_shader_compile) instead of stalling the first frame
    await this.renderer.compileAsync(this.scene, this.rig.camera)
    if (this.disposed) return
    progress(1, 'Ready')
    this.loop()
    this.events.onReady?.()
  }

  private setupComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(this.renderer, target)
    this.composer.addPass(new RenderPass(this.scene, this.rig.camera))
    // cap extreme HDR values (hundreds of overlapping fire sprites) so bloom can't smear a halo over the whole frame
    this.composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main() { vec4 c = texture2D(tDiffuse, vUv); float m = max(c.r, max(c.g, c.b)); gl_FragColor = vec4(c.rgb * min(1.0, 7.0 / max(m, 1e-4)), c.a); }',
    }))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.6, 0.6, 2.4)
    this.composer.addPass(this.bloom)
    this.lens = new LensPass()
    this.composer.addPass(this.lens as unknown as ShaderPass)
    this.composer.addPass(new OutputPass())
  }

  private resize = () => {
    const w = this.host.clientWidth, h = this.host.clientHeight
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = w + 'px'
    this.renderer.domElement.style.height = h + 'px'
    this.rig.camera.aspect = w / h
    this.rig.camera.updateProjectionMatrix()
    const pr = this.renderer.getPixelRatio()
    this.composer?.setSize(w, h)
    this.bloom?.setSize(w * pr, h * pr)
  }

  setTimeOfDay(t: TimeOfDay) {
    this.atmosphere.apply(t)
    const fog = this.scene.fog as THREE.FogExp2
    this.water.uFogColor.value.copy(fog.color)
    this.water.uFogDensity.value = fog.density
    this.water.uSunDir.value.copy(this.atmosphere.sunDir)
    this.water.uSunColor.value.copy(this.atmosphere.sun.color)
    this.water.uNight.value = this.atmosphere.night
    this.ground.uNight.value = this.atmosphere.night
    this.water.uSkyColor.value.copy(this.atmosphere.hemi.color)
    this.water.uHorizon.value.copy(fog.color)
    this.traffic?.setNight(this.atmosphere.night)
    const a = this.atmosphere
    const sunColor = a.sun.color.clone().multiplyScalar(a.sun.intensity / 3)
    const amb = a.hemi.color.clone().multiplyScalar(a.hemi.intensity * 0.9)
    for (const u of [this.particles?.uniforms, this.debris?.uniforms]) {
      if (!u) continue
      u.uSunDir.value.copy(a.sunDir)
      u.uSunColor.value.copy(sunColor)
      u.uFogColor.value.copy(fog.color)
      u.uFogDensity.value = fog.density
    }
    if (this.particles) this.particles.uniforms.uAmbient.value.copy(amb)
    if (this.debris) {
      this.debris.uniforms.uSky.value.copy(amb)
      this.debris.uniforms.uGround.value.copy(a.hemi.groundColor).multiplyScalar(a.hemi.intensity)
    }
  }

  setPower(p: Power | null) {
    this.power = p
    this.reticle.visible = !!p
  }

  private tap(ndc: THREE.Vector2, e: PointerEvent) {
    if (!this.power) return
    const p = this.rig.ground(ndc)
    if (!p) return
    this.sound.unlock()
    this.disasters.trigger(this.power, p, e.altKey)
  }

  rebuild() { this.disasters.rebuild() }

  /** Damage helpers used by the disasters. */
  setBuilding(i: number, collapse: number, tilt: number, dir: number, scorch: number) {
    const s = this.buildings.state
    s[i * 4] = Math.max(s[i * 4], collapse)
    if (Math.abs(tilt) > Math.abs(s[i * 4 + 1])) { s[i * 4 + 1] = tilt; s[i * 4 + 2] = dir }
    s[i * 4 + 3] = Math.max(s[i * 4 + 3], scorch)
    this.buildings.touch()
  }

  /** Film mode: the render loop stops and `advance` steps the world by exact frames (for recording footage). */
  manual = false
  /** Parked (e.g. behind the globe): the loop idles without stepping or rendering, after one warm-up frame. */
  paused = false

  advance(dt: number) {
    this.step(dt, performance.now())
  }

  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now()
    const real = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    if (!this.manual && (!this.paused || this.frames === 0)) this.step(real, now)
  }

  private step(real: number, now: number) {
    const dt = real * this.timeScale
    this.time += dt
    this.frames++
    this.fps = this.fps * 0.95 + (1 / Math.max(real, 0.001)) * 0.05
    this.rig.update(real)
    this.atmosphere.update(this.rig.focus, this.rig.cur.distance, real)
    this.disasters.update(dt, real)
    for (const l of this.landmarks) applyLandmark(l)
    this.buildings.update(this.time, this.atmosphere.night)
    this.traffic.update(dt, this)
    this.particles.update(this.time, this.rig.camera)
    this.debris.update(this.time)
    this.ground.uTime.value = this.time
    this.water.uTime.value = this.time
    if (this.power && this.hoverPoint) {
      const r = this.disasters.radius(this.power)
      this.reticle.position.set(this.hoverPoint.x, 1.5, this.hoverPoint.z)
      this.reticle.scale.setScalar(r)
      ;(this.reticle.material as THREE.MeshBasicMaterial).opacity = this.disasters.busy() ? 0.12 : 0.4 + 0.15 * Math.sin(now * 0.006)
    }
    this.lens.update(this, real)
    this.composer.render(real)
  }

  resetLandmarks() { for (const l of this.landmarks) resetLandmark(l) }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    this.rig.dispose()
    this.sound.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
