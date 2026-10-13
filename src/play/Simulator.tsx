import { useEffect, useRef, useState } from 'react'
import { Engine, type Power } from '../engine/engine'
import type { TimeOfDay } from '../engine/city/atmosphere'
import { BackIcon, DuskIcon, MeteorIcon, MoonIcon, NukeIcon, RebuildIcon, SlowIcon, SoundIcon, SunIcon, WaveIcon } from '../ui/icons'
import { whenIdle } from './idle'
import './simulator.css'

const ESTABLISHING = { x: 380, z: 120, distance: 3500, yaw: 0.22, pitch: 0.44 }
const HIGH = { x: 350, z: 0, distance: 7500, yaw: 0.18, pitch: 1.4 }

const POWERS: { id: Power; name: string; key: string; hint: string; Icon: () => React.JSX.Element }[] = [
  { id: 'nuke', name: 'Nuke', key: '1', hint: 'Click anywhere to detonate', Icon: NukeIcon },
  { id: 'tsunami', name: 'Tsunami', key: '2', hint: 'Click where the wave should hit', Icon: WaveIcon },
  { id: 'meteor', name: 'Meteor', key: '3', hint: 'Click where it should land', Icon: MeteorIcon },
]

export function Simulator({ onExit, onReady, active = true }: { onExit?: () => void; onReady?: (engine: Engine) => void; active?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const [progress, setProgress] = useState({ p: 0, label: 'Downloading Toronto' })
  const [ready, setReady] = useState(false)
  const [power, setPower] = useState<Power | null>(null)
  const [time, setTime] = useState<TimeOfDay>('golden')
  const [slow, setSlow] = useState(false)
  const [muted, setMuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [damaged, setDamaged] = useState(false)
  const [help, setHelp] = useState(true)
  const [film] = useState(() => location.search.includes('film'))
  const [touch] = useState(() => matchMedia('(pointer: coarse)').matches)

  useEffect(() => {
    if (!host.current) return
    const engine = new Engine(host.current, {
      onProgress: (p, label) => setProgress({ p, label }),
      onReady: () => {
        setReady(true)
        onReady?.(engine)
      },
      onBusy: b => {
        setBusy(b)
        if (b) setDamaged(true)
      },
      // build the city in the globe's quiet moments, not mid-drag
      yieldTo: () => whenIdle(),
    })
    engineRef.current = engine
    // parked high above the city until the player arrives from the globe
    engine.rig.set(activeRef.current ? ESTABLISHING : HIGH, true)
    // parked behind the globe it renders one warm-up frame and then nothing, so the globe has the GPU to itself
    engine.paused = !activeRef.current
    void engine.load()
    ;(window as unknown as { __gp: Engine }).__gp = engine
    return () => engine.dispose()
  }, [onReady])

  // arriving: descend into an establishing shot of the skyline from over the lake
  const activeRef = useRef(active)
  useEffect(() => {
    const was = activeRef.current
    activeRef.current = active
    const engine = engineRef.current
    if (!engine) return
    engine.rig.enabled = active
    engine.paused = !active
    if (active && !was) engine.rig.flyTo(ESTABLISHING, 4.2)
  }, [active])

  useEffect(() => { engineRef.current?.setPower(power) }, [power])
  useEffect(() => { if (ready) engineRef.current?.setTimeOfDay(time) }, [time, ready])
  useEffect(() => { if (engineRef.current) engineRef.current.timeScale = slow ? 0.3 : 1 }, [slow])
  useEffect(() => { engineRef.current?.sound.setMuted(muted) }, [muted])
  useEffect(() => {
    if (!ready || !active) return
    const t = setTimeout(() => setHelp(false), 10000)
    return () => clearTimeout(t)
  }, [ready, active])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea')) return
      const p = POWERS.find(p => p.key === e.key)
      if (p) setPower(cur => (cur === p.id ? null : p.id))
      if (e.key === 'Escape') setPower(null)
      if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) rebuild()
      if (e.key.toLowerCase() === 't') setSlow(s => !s)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const rebuild = () => {
    engineRef.current?.rebuild()
    setDamaged(false)
  }
  const armed = POWERS.find(p => p.id === power)

  return (
    <div className={`sim ${power ? 'is-aiming' : ''} ${active ? 'is-active' : 'is-parked'} ${film ? 'is-film' : ''}`}>
      <div className="sim-stage" ref={host} />

      <div className={`sim-loading ${ready ? 'is-done' : ''}`} aria-hidden={ready}>
        <div className="sim-loading-inner">
          <div className="sim-loading-label">{progress.label}</div>
          <div className="sim-loading-bar"><span style={{ transform: `scaleX(${progress.p})` }} /></div>
        </div>
      </div>

      <header className="sim-top">
        {onExit ? (
          <button className="sim-chip sim-back" onClick={onExit} aria-label="Back to the globe">
            <BackIcon />
            <span>Toronto</span>
          </button>
        ) : <div className="sim-chip"><span>Toronto</span></div>}
        <div className="sim-group" role="group" aria-label="Time of day">
          {([['day', SunIcon, 'Day'], ['golden', DuskIcon, 'Golden hour'], ['night', MoonIcon, 'Night']] as const).map(([id, Icon, label]) => (
            <button key={id} className={`sim-icon ${time === id ? 'is-on' : ''}`} onClick={() => setTime(id)} aria-label={label} title={label}><Icon /></button>
          ))}
          <span className="sim-divider" />
          <button className={`sim-icon ${slow ? 'is-on' : ''}`} onClick={() => setSlow(s => !s)} aria-label="Slow motion" title="Slow motion (T)"><SlowIcon /></button>
          <button className="sim-icon" onClick={() => setMuted(m => !m)} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}><SoundIcon muted={muted} /></button>
        </div>
      </header>

      <div className={`sim-hint ${armed || help ? 'is-on' : ''}`}>
        {armed ? <><b>{armed.name}</b> · {touch ? armed.hint.replace('Click', 'Tap') : armed.hint} {!touch && <span className="sim-hint-key">Esc</span>}</> : touch ? <>Drag to orbit · Pinch to zoom · <b>Pick a power below</b></> : <>Drag to orbit · Right-drag to pan · Scroll to zoom · <b>Pick a power below</b></>}
      </div>

      <nav className="sim-dock" aria-label="Powers">
        {POWERS.map(({ id, name, key, Icon }) => (
          <button key={id} className={`sim-power ${power === id ? 'is-on' : ''}`} onClick={() => setPower(power === id ? null : id)} aria-pressed={power === id}>
            <Icon />
            <span className="sim-power-name">{name}</span>
            <span className="sim-power-key">{key}</span>
          </button>
        ))}
        <span className="sim-dock-divider" />
        <button className={`sim-power sim-rebuild ${damaged ? 'is-ready' : ''}`} onClick={rebuild} disabled={!damaged && !busy}>
          <RebuildIcon />
          <span className="sim-power-name">Rebuild</span>
          <span className="sim-power-key">R</span>
        </button>
      </nav>

      <footer className="sim-credit">Toronto from OpenStreetMap and the City of Toronto's 3D Massing</footer>
    </div>
  )
}
