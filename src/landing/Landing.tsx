import { useEffect, useRef } from 'react'
import { navigate } from '../router'
import { CityMark, Wordmark } from './Wordmark'
import { Desktop } from './Desktop'
import './landing.css'

/** A muted clip that only plays while it is on screen. */
function Clip({ id, className }: { id: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) void v.play().catch(() => {}); else v.pause() }, { threshold: 0.2 })
    io.observe(v)
    return () => io.disconnect()
  }, [])
  return <video ref={ref} className={className} src={`/media/${id}.mp4`} poster={`/media/${id}.jpg`} muted loop playsInline preload="metadata" aria-hidden="true" />
}

const GlobeIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="10" cy="10" r="7.25" />
    <ellipse cx="10" cy="10" rx="3.1" ry="7.25" />
    <path d="M3 10h14" />
  </svg>
)

export function Landing() {
  useEffect(() => {
    document.title = "God's Plan: Toronto as Drake intended"
    // warm the globe and the city download while the visitor watches
    const t = setTimeout(() => { import('../play/Play').catch(() => {}); void fetch('/data/toronto.json', { priority: 'low' } as RequestInit).catch(() => {}) }, 2500)
    return () => clearTimeout(t)
  }, [])
  const go = () => navigate('/play')

  return (
    <div className="lp">
      <div className="lp-sky" aria-hidden="true" />
      <nav className="lp-nav">
        <a className="lp-brand" href="/" aria-label="God's Plan">
          <CityMark height={22} className="lp-brand-mark" />
          <Wordmark height={14} />
        </a>
        <div className="lp-nav-links">
          <a href="https://github.com/EvanJYHe/gods-plan" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-eyebrow">God's Plan</div>
        <h1>Toronto as Drake intended.</h1>
        <hr />
        <p>Cities simulated by agent swarms and real physics. Flood it, flatten it, watch every resident react.</p>
        <button className="lp-btn" onClick={go}><GlobeIcon />Enter the Simulation</button>
        <Desktop>
          <Clip id="hero-film" />
        </Desktop>
      </header>
    </div>
  )
}
