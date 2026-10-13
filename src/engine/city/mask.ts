import { CanvasTexture, Vector4 } from 'three'
import type { CityData, Poly } from '../data'

/** A coarse water/land grid over the pack (10 m cells), rasterized once with a 2D canvas. */
export class WaterMask {
  readonly cell = 10
  readonly w: number
  readonly h: number
  private x0: number
  private z0: number
  private data: Uint8ClampedArray
  private canvas: HTMLCanvasElement
  private tex: CanvasTexture | null = null

  constructor(data: CityData) {
    const [bx0, bz0, bx1, bz1] = data.bounds
    // scene z = -world z
    this.x0 = bx0
    this.z0 = -bz1
    this.w = Math.ceil((bx1 - bx0) / this.cell)
    this.h = Math.ceil((bz1 - bz0) / this.cell)
    const canvas = document.createElement('canvas')
    canvas.width = this.w
    canvas.height = this.h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, this.w, this.h)
    ctx.fillStyle = '#fff'
    const draw = (polys: Poly[]) => {
      for (const [ring, holes] of polys) {
        ctx.beginPath()
        for (const r of [ring, ...(holes ?? [])]) {
          for (let i = 0; i < r.length; i += 2) {
            const x = (r[i] / 10 - this.x0) / this.cell
            const y = (-r[i + 1] / 10 - this.z0) / this.cell
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          }
          ctx.closePath()
        }
        ctx.fill('evenodd')
      }
    }
    draw(data.water)
    draw(data.farWater)
    this.data = ctx.getImageData(0, 0, this.w, this.h).data
    this.canvas = canvas
  }

  /** The mask as a texture (lake = white) and its box in scene xz: (x0, z0, width, height). */
  texture() {
    if (!this.tex) {
      this.tex = new CanvasTexture(this.canvas)
      this.tex.flipY = false
    }
    return this.tex
  }

  box() { return new Vector4(this.x0, this.z0, this.w * this.cell, this.h * this.cell) }

  /** True if the scene point (x, z) is water. Outside the pack: water to the south, land elsewhere. */
  isWater(x: number, z: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((z - this.z0) / this.cell)
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return j >= this.h
    return this.data[(j * this.w + i) * 4] > 127
  }
}
