/**
 * GOD'S PLAN in the card film's lettering (ported from jusin-website-copy/scripts/films/films.html, GP_GLYPHS):
 * cap height 98 units, strokes 21, every glyph box 106 tall with 4 units of margin. Drawn in currentColor.
 */
const cx = 55.5, cy = 53, r = 40.5
const pt = (deg: number) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)]
const [g0x, g0y] = pt(0), [g1x, g1y] = pt(-56)

const GLYPHS: [number, string][] = [
  [111, `<path d="M${g0x} ${g0y} A${r} ${r} 0 1 1 ${g1x} ${g1y}" fill="none" stroke="currentColor" stroke-width="21"/><rect x="${cx + 4}" y="${cy - 10.5}" width="${g0x + 10.5 - cx - 4}" height="21"/>`],
  [111, `<circle cx="55.5" cy="53" r="41" fill="none" stroke="currentColor" stroke-width="21"/>`],
  [102, `<rect x="4" y="4" width="21" height="98"/><path d="M14.5 14.5 H45 A38.5 38.5 0 0 1 45 91.5 H14.5" fill="none" stroke="currentColor" stroke-width="21"/>`],
  [41, `<path d="M14 4 H37 L27 40 H4 Z"/>`],
  [53, `<path clip-path="url(#gpS)" d="M47 -8 L11 44 L44 78 L6 114" fill="none" stroke="currentColor" stroke-width="21" stroke-linejoin="round"/>`],
  [30, ''],
  [88, `<rect x="4" y="4" width="21" height="98"/><path d="M14.5 14.5 H42 A27.5 27.5 0 0 1 42 69.5 H14.5" fill="none" stroke="currentColor" stroke-width="21"/>`],
  [85, `<path d="M4 4 H29 L81 102 H56 Z"/>`],
  [127, `<path fill-rule="evenodd" d="M4 102 L51 4 H76 L123 102 Z M39.07 81 L63.5 30.1 L87.9 81 Z"/>`],
  [84, `<rect x="4" y="4" width="21" height="98"/><rect x="59" y="4" width="21" height="98"/><path d="M4 4 H29 L80 102 H55 Z"/>`],
]

let x = 0
const body = GLYPHS.map(([w, svg]) => {
  const g = svg ? `<g transform="translate(${x} 0)">${svg.replace('url(#gpS)', `url(#gpS${x})`)}${svg.includes('gpS') ? `<clipPath id="gpS${x}"><rect x="-10" y="4" width="73" height="98"/></clipPath>` : ''}</g>` : ''
  x += w
  return g
}).join('')
const WIDTH = x

export function Wordmark({ height = 20, className }: { height?: number; className?: string }) {
  return (
    <svg className={className} role="img" aria-label="God's Plan" viewBox={`0 0 ${WIDTH} 106`} height={height} width={(height * WIDTH) / 106}
      fill="currentColor" dangerouslySetInnerHTML={{ __html: body }} />
  )
}

/** The film's little city (CN Tower on a block), traced artwork. */
export function CityMark({ height = 28, className }: { height?: number; className?: string }) {
  return <img className={className} src="/media/gp-city.svg" alt="" height={height} width={(height * 2745) / 2337} />
}
