import { useCallback, useEffect, useRef, useState } from 'react'
import { Globe } from './globe'
import { CITIES, type City } from './cities'
import { Simulator } from './Simulator'
import { Wordmark } from '../landing/Wordmark'
import { navigate } from '../router'
import './play.css'

const coords = (c: City) =>
  `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'N' : 'S'}  ${Math.abs(c.lon).toFixed(2)}° ${c.lon >= 0 ? 'E' : 'W'}`

/**
 * /play: the globe over the painted sky, with one live city. Toronto drops you in: the Earth spins it to face you and
 * dives, and the simulator descends into its establishing shot. Esc or back returns here.
 */
export function Play() {
  const host = useRef<HTMLDivElement>(null)
  const globeRef = useRef<Globe | null>(null)
  const labels = useRef(new Map<string, HTMLElement>())
  const [phase, setPhase] = useState<'globe' | 'diving' | 'city'>(() => (location.hash === '#toronto' ? 'city' : 'globe'))
  const [hover, setHover] = useState<City | null>(null)

  const enter = useCallback((city: City) => {
    const g = globeRef.current
    if (!g) return
    if (!city.live) {
      g.focus(city)
      setHover(city)
      return
    }
    setPhase('diving')
    g.enter(city, () => setPhase('city'))
  }, [])
  const enterRef = useRef(enter)
  enterRef.current = enter

  useEffect(() => {
    if (!host.current) return
    const g = new Globe(host.current)
    globeRef.current = g
    for (const [id, el] of labels.current) g.bindLabel(id, el)
    g.onHover = city => setHover(city)
    g.onPick = city => enterRef.current(city)
    return () => {
      g.dispose()
      globeRef.current = null
    }
  }, [])

  const bindLabel = (id: string) => (el: HTMLElement | null) => {
    if (el) labels.current.set(id, el)
    else labels.current.delete(id)
    globeRef.current?.bindLabel(id, el)
  }

  // the globe stops rendering once the city has taken over (after the layer's fade)
  useEffect(() => {
    const g = globeRef.current
    if (!g) return
    if (phase !== 'city') { g.paused = false; return }
    const t = setTimeout(() => { g.paused = true }, 1500)
    return () => clearTimeout(t)
  }, [phase])

  const back = useCallback(() => {
    history.replaceState(null, '', '/play' + location.search)
    globeRef.current?.reset()
    setHover(null)
    setPhase('globe')
  }, [])

  useEffect(() => {
    if (phase === 'city') history.replaceState(null, '', '/play' + location.search + '#toronto')
  }, [phase])

  // Esc in the city goes back to the globe, unless it is disarming a power first
  useEffect(() => {
    if (phase !== 'city') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.sim.is-aiming')) back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, back])


  return (
    <div className={`play is-${phase}`}>
      <Simulator active={phase === 'city'} onExit={back} />
      <div className="globe-layer" aria-hidden={phase === 'city'}>
        <div className="gp-sky" />
        <div className="globe-stage" ref={host} />
        <div className="gp-pins">
          {CITIES.map(c => (
            <div key={c.id} ref={bindLabel(c.id)} data-side={c.side ?? 'ne'} className={`gp-pin ${c.live ? 'is-live' : 'is-locked'} ${hover?.id === c.id ? 'is-hover' : ''}`}>
              <svg className="gp-pin-lead" viewBox="0 0 24 24" aria-hidden="true"><path d="M0 24 24 0" pathLength={1} /></svg>
              <button className="gp-pin-tag" tabIndex={phase === 'globe' ? 0 : -1} onClick={() => enter(c)} onPointerEnter={() => setHover(c)} onPointerLeave={() => setHover(null)}
                aria-label={c.live ? `Enter ${c.name}` : `${c.name}, soon`}>
                <span className="gp-pin-name">{c.name}</span>
                <span className="gp-pin-meta">{coords(c)}</span>
              </button>
              <div className="gp-pin-tease">{c.tease}</div>
            </div>
          ))}
        </div>

        <header className="gp-top">
          <a className="gp-brand" href="/" onClick={e => { e.preventDefault(); navigate('/') }} aria-label="God's Plan, home"><Wordmark height={14} /></a>
        </header>
        <h1 className="gp-title">Where to?</h1>
      </div>
      <div className="dive-veil" />
    </div>
  )
}
