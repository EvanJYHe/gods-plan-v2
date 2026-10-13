import * as THREE from 'three'
import { Sky } from 'three/examples/jsm/objects/Sky.js'

/** Sky dome, sun, hemisphere light, fog and image-based lighting, driven by a time-of-day preset. */

export type TimeOfDay = 'day' | 'golden' | 'night'

interface Preset {
  elevation: number
  azimuth: number
  sun: number
  sunColor: number
  hemi: number
  sky: number
  ground: number
  fog: number
  fogDensity: number
  turbidity: number
  rayleigh: number
  exposure: number
  night: number
  env: number
}

const PRESETS: Record<TimeOfDay, Preset> = {
  day: { elevation: 48, azimuth: 318, sun: 2.6, sunColor: 0xfff0dc, hemi: 0.34, sky: 0x86abe0, ground: 0x4d4b43, fog: 0xa8bcd6, fogDensity: 0.00005, turbidity: 2.2, rayleigh: 1.2, exposure: 0.38, night: 0, env: 0.24 },
  golden: { elevation: 9, azimuth: 278, sun: 3.7, sunColor: 0xffab6a, hemi: 0.55, sky: 0x7a9dd2, ground: 0x4a3b2f, fog: 0xb4bfcc, fogDensity: 0.00006, turbidity: 2.6, rayleigh: 2.6, exposure: 0.62, night: 0.2, env: 0.42 },
  night: { elevation: -9, azimuth: 312, sun: 0.34, sunColor: 0x8ea8ff, hemi: 0.3, sky: 0x22324f, ground: 0x07080b, fog: 0x0c1220, fogDensity: 0.00008, turbidity: 2, rayleigh: 0.6, exposure: 0.95, night: 1, env: 0.08 },
}

export class Atmosphere {
  readonly sky: Sky
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly sunDir = new THREE.Vector3()
  night = 0
  preset: TimeOfDay = 'golden'
  private pmrem: THREE.PMREMGenerator
  private envScene = new THREE.Scene()
  private envRT: THREE.WebGLRenderTarget | null = null
  private flash = 0

  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer) {
    this.sky = new Sky()
    this.sky.scale.setScalar(100000)
    // The sky shader pins itself to the far plane; with a reversed depth buffer that is the near plane, so draw it
    // first and never depth-test it.
    this.sky.renderOrder = -10
    this.sky.material.depthTest = false
    this.sky.material.depthWrite = false
    this.sky.frustumCulled = false
    scene.add(this.sky)
    this.sun = new THREE.DirectionalLight(0xffffff, 3)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(4096, 4096)
    this.sun.shadow.bias = -0.0004
    this.sun.shadow.normalBias = 0.6
    const cam = this.sun.shadow.camera
    cam.near = 10
    cam.far = 6000
    scene.add(this.sun, this.sun.target)
    this.hemi = new THREE.HemisphereLight(0xbcd4ec, 0x6b6a5c, 0.8)
    scene.add(this.hemi)
    scene.fog = new THREE.FogExp2(0xc9d6e2, 0.00012)
    this.pmrem = new THREE.PMREMGenerator(renderer)
    const envSky = new Sky()
    envSky.scale.setScalar(1000)
    this.envScene.add(envSky)
    this.apply('golden')
  }

  apply(preset: TimeOfDay) {
    this.preset = preset
    const p = PRESETS[preset]
    const phi = THREE.MathUtils.degToRad(90 - p.elevation)
    const theta = THREE.MathUtils.degToRad(p.azimuth)
    this.sunDir.setFromSphericalCoords(1, phi, theta)
    for (const sky of [this.sky, this.envScene.children[0] as Sky]) {
      const u = sky.material.uniforms
      u.sunPosition.value.copy(this.sunDir)
      u.turbidity.value = p.turbidity
      u.rayleigh.value = p.rayleigh
      u.mieCoefficient.value = preset === 'golden' ? 0.0022 : 0.003
      u.mieDirectionalG.value = 0.72
    }
    this.sun.color.set(p.sunColor)
    this.sun.intensity = p.sun
    this.hemi.color.set(p.sky)
    this.hemi.groundColor.set(p.ground)
    this.hemi.intensity = p.hemi
    const fog = this.scene.fog as THREE.FogExp2
    fog.color.set(p.fog)
    fog.density = p.fogDensity
    this.renderer.toneMappingExposure = p.exposure
    this.night = p.night
    // The moon at night: a cool light from high up, so buildings still read.
    if (preset === 'night') this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(50), theta)
    this.envRT?.dispose()
    this.envRT = this.pmrem.fromScene(this.envScene, 0, 0.1, 2000)
    this.scene.environment = this.envRT.texture
    this.scene.environmentIntensity = p.env
    this.sky.visible = true
  }

  /** Follow the camera's focus with the shadow frustum (sized to the view). */
  update(focus: THREE.Vector3, viewRadius: number, dt: number) {
    const extent = THREE.MathUtils.clamp(viewRadius * 1.25, 250, 2600)
    const cam = this.sun.shadow.camera
    if (Math.abs(cam.right - extent) > extent * 0.15) {
      cam.left = -extent
      cam.right = extent
      cam.top = extent
      cam.bottom = -extent
      cam.updateProjectionMatrix()
    }
    // snap to texel grid to stop shadow shimmer
    const texel = (extent * 2) / this.sun.shadow.mapSize.x
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel
    this.sun.target.position.set(fx, 0, fz)
    this.sun.position.set(fx + this.sunDir.x * 3000, Math.max(this.sunDir.y, 0.12) * 3000, fz + this.sunDir.z * 3000)
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6)
  }
}
