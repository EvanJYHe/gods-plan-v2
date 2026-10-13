/**
 * All sound is synthesized with WebAudio (no files): filtered noise for blasts, rumble, wind, water and debris, and
 * sine sweeps for the sub-bass. A quiet city ambience runs underneath once the player has interacted.
 */

export class Sound {
  private ctx: AudioContext | null = null
  private master!: GainNode
  private bus!: DynamicsCompressorNode
  private noise!: AudioBuffer
  private brown!: AudioBuffer
  private ambience: { gain: GainNode; stop: () => void } | null = null
  muted = false

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    this.ctx = ctx
    this.bus = ctx.createDynamicsCompressor()
    this.bus.threshold.value = -16
    this.bus.ratio.value = 5
    this.bus.attack.value = 0.003
    this.bus.release.value = 0.4
    this.master = ctx.createGain()
    this.master.gain.value = this.muted ? 0 : 0.85
    this.bus.connect(this.master).connect(ctx.destination)
    const len = ctx.sampleRate * 4
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    this.brown = ctx.createBuffer(1, len, ctx.sampleRate)
    const w = this.noise.getChannelData(0), b = this.brown.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      w[i] = Math.random() * 2 - 1
      last = (last + 0.02 * w[i]) / 1.02
      b[i] = last * 3.5
    }
    this.startAmbience()
  }

  setMuted(m: boolean) {
    this.muted = m
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05)
  }

  private src(buf: AudioBuffer, loop = true) {
    const s = this.ctx!.createBufferSource()
    s.buffer = buf
    s.loop = loop
    s.loopStart = Math.random() * 2
    return s
  }

  private env(gain: GainNode, t0: number, attack: number, peak: number, decay: number) {
    const g = gain.gain
    g.setValueAtTime(0.0001, t0)
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack)
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  }

  private startAmbience() {
    const ctx = this.ctx!
    const wind = this.src(this.brown)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = 380
    const g = ctx.createGain()
    g.gain.value = 0.05
    // slow gusts
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.07
    const lg = ctx.createGain()
    lg.gain.value = 0.025
    lfo.connect(lg).connect(g.gain)
    wind.connect(f).connect(g).connect(this.bus)
    wind.start()
    lfo.start()
    this.ambience = { gain: g, stop: () => { wind.stop(); lfo.stop() } }
  }

  /** A blast heard from `distance` metres: the crack arrives first, the boom a little later. */
  explosion(distance: number, power = 1) {
    if (!this.ctx) return
    const ctx = this.ctx
    const now = ctx.currentTime
    const delay = Math.min(2.2, distance / 1400)
    const loud = Math.min(1, power * (1.2 - Math.min(distance, 6000) / 7000))
    // crack
    const crack = this.src(this.noise, false)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 900
    const cg = ctx.createGain()
    crack.connect(hp).connect(cg).connect(this.bus)
    this.env(cg, now + delay * 0.4, 0.004, 0.5 * loud, 0.35)
    crack.start(now + delay * 0.4)
    crack.stop(now + delay + 1)
    // body: low-passed noise that closes slowly
    const body = this.src(this.noise, false)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(2200, now + delay)
    lp.frequency.exponentialRampToValueAtTime(90, now + delay + 3.5)
    const bg = ctx.createGain()
    body.connect(lp).connect(bg).connect(this.bus)
    this.env(bg, now + delay, 0.02, 1.4 * loud, 4.5)
    body.start(now + delay)
    body.stop(now + delay + 5)
    // sub drop
    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(70, now + delay)
    sub.frequency.exponentialRampToValueAtTime(24, now + delay + 2.5)
    const sg = ctx.createGain()
    sub.connect(sg).connect(this.bus)
    this.env(sg, now + delay, 0.03, 1.1 * loud, 3.2)
    sub.start(now + delay)
    sub.stop(now + delay + 3.5)
    this.rumble(9 * power, 0.5 * loud, delay + 0.5)
  }

  /** A long low rumble (collapsing buildings, the cloud). */
  rumble(duration: number, level: number, delay = 0) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime + delay
    const s = this.src(this.brown)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 160
    const g = ctx.createGain()
    s.connect(lp).connect(g).connect(this.bus)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(level, 0.0002), t0 + duration * 0.2)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
    s.start(t0)
    s.stop(t0 + duration + 0.1)
  }

  /** Scattered crunches of masonry. */
  debris(count: number, spread: number, level = 0.25) {
    if (!this.ctx) return
    const ctx = this.ctx
    for (let i = 0; i < count; i++) {
      const t0 = ctx.currentTime + Math.random() * spread
      const s = this.src(this.noise, false)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 180 + Math.random() * 900
      bp.Q.value = 1.4
      const g = ctx.createGain()
      s.connect(bp).connect(g).connect(this.bus)
      this.env(g, t0, 0.005, level * (0.3 + Math.random() * 0.7), 0.25 + Math.random() * 0.5)
      s.start(t0)
      s.stop(t0 + 1)
    }
  }

  /** The wave: a roar that swells, crashes and drains away. Returns a control to steer its loudness. */
  wave(duration: number) {
    if (!this.ctx) return null
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const s = this.src(this.noise)
    const bp = ctx.createBiquadFilter()
    bp.type = 'lowpass'
    bp.frequency.value = 600
    const g = ctx.createGain()
    g.gain.value = 0.0001
    const deep = this.src(this.brown)
    const dg = ctx.createGain()
    dg.gain.value = 0.0001
    s.connect(bp).connect(g).connect(this.bus)
    deep.connect(dg).connect(this.bus)
    s.start(t0)
    deep.start(t0)
    s.stop(t0 + duration)
    deep.stop(t0 + duration)
    return {
      set: (level: number, brightness: number) => {
        const t = ctx.currentTime
        g.gain.setTargetAtTime(Math.max(0.0001, level * 0.9), t, 0.2)
        dg.gain.setTargetAtTime(Math.max(0.0001, level * 0.8), t, 0.3)
        bp.frequency.setTargetAtTime(300 + brightness * 2600, t, 0.3)
      },
    }
  }

  /** The meteor's descent: a falling, brightening whoosh. */
  whoosh(duration: number) {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const s = this.src(this.noise)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 2.5
    bp.frequency.setValueAtTime(3200, t0)
    bp.frequency.exponentialRampToValueAtTime(220, t0 + duration)
    const g = ctx.createGain()
    s.connect(bp).connect(g).connect(this.bus)
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(0.5, t0 + duration * 0.95)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration + 0.08)
    s.start(t0)
    s.stop(t0 + duration + 0.2)
  }

  /** Rising and settling: the city rebuilding itself. */
  rebuild() {
    if (!this.ctx) return
    const ctx = this.ctx
    const t0 = ctx.currentTime
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.setValueAtTime(140, t0)
    o.frequency.exponentialRampToValueAtTime(420, t0 + 1.8)
    const g = ctx.createGain()
    o.connect(g).connect(this.bus)
    this.env(g, t0, 0.3, 0.08, 1.8)
    o.start(t0)
    o.stop(t0 + 2.2)
    this.debris(18, 2.0, 0.08)
  }

  dispose() {
    this.ambience?.stop()
    void this.ctx?.close()
  }
}
