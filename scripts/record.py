"""Record landing-page footage from the running app, frame by frame (exact 30 fps regardless of machine speed).

Run the dev server (npm run dev), then, with the dedicated browser:
  BU_NAME=gp-rec browser-harness-ai < scripts/record.py      (reads /tmp/gp_rec.json: {"shot": name})
Frames go to /tmp/gp-rec/<shot>/; scripts/encode.sh turns them into public/media/*.mp4.
"""
import json, os, time, shutil

cfg = json.load(open('/tmp/gp_rec.json'))
SHOTS = {
    # name: viewport, preset, camera, pre-roll frames, frames, events {frame: js}, camera move
    'hero-nuke': dict(size=[1920, 1080], tod='golden', cam=dict(x=420, z=200, distance=3300, yaw=0.2, pitch=0.2), pre=20, frames=240,
                      events={10: "g.disasters.trigger('nuke', new V(450, 0, -700))"}, move=dict(yaw=0.3, distance=3900, pitch=0.24, dur=8),
                      speed=lambda f: 1 if f < 70 else min(3.2, 1 + (f - 70) / 25)),
    'hero-tsunami': dict(size=[1920, 1080], tod='golden', cam=None, frames=165,
                         setup="g.disasters.trigger('tsunami', new V(450, 0, -300))", pre=300,
                         after="let s = -300; while (!g.disasters.mask.isWater(450, s) && s < 3000) s += 10; g.rig.set({x: 450, z: s - 200, distance: 2800, yaw: Math.PI + 0.55, pitch: 0.3}, true)",
                         events={}, move=dict(yaw=3.14159 + 0.62, distance=2450, pitch=0.26, dur=5.5)),
    'hero-meteor': dict(size=[1920, 1080], tod='golden', cam=dict(x=600, z=-80, distance=2700, yaw=0.95, pitch=0.3), pre=10, frames=165,
                        events={4: "g.disasters.trigger('meteor', new V(760, 0, -260))"}, move=dict(yaw=0.88, distance=2850, dur=5.5)),
    'nuke': dict(size=[864, 1080], tod='golden', cam=dict(x=300, z=-100, distance=4300, yaw=-0.25, pitch=0.2), pre=20, frames=240,
                 events={6: "g.disasters.trigger('nuke', new V(220, 0, -760))"}, move=dict(yaw=-0.18, distance=4700, pitch=0.24, dur=8),
                 speed=lambda f: 1 if f < 60 else min(3.4, 1 + (f - 60) / 22)),
    'tsunami': dict(size=[864, 1080], tod='golden', cam=None, frames=240,
                    setup="g.disasters.trigger('tsunami', new V(200, 0, -380))", pre=300,
                    after="g.rig.set({x: 150, z: 1300, distance: 3300, yaw: -0.45, pitch: 0.3}, true)",
                    events={}, move=dict(yaw=-0.36, distance=2900, pitch=0.27, dur=8)),
    'meteor': dict(size=[864, 1080], tod='golden', cam=dict(x=500, z=-200, distance=2600, yaw=0.6, pitch=0.3), pre=10, frames=210,
                   events={4: "g.disasters.trigger('meteor', new V(560, 0, -420))"}, move=dict(yaw=0.52, distance=2750, dur=7)),
    'city': dict(size=[1600, 1000], tod='golden', cam=dict(x=380, z=-300, distance=2300, yaw=-0.4, pitch=0.32), pre=10, frames=270,
                 events={}, move=dict(yaw=0.35, distance=2200, dur=9)),
    # the portfolio card's footage: closer, lower and faster than the landing clips
    'card-establish': dict(size=[1920, 1080], tod='golden', cam=dict(x=260, z=330, distance=1750, yaw=0.06, pitch=0.075), pre=12, frames=60,
                           events={}, move=dict(distance=1520, pitch=0.085, dur=2.0)),
    'card-nuke': dict(size=[1920, 1080], tod='golden', cam=dict(x=260, z=330, distance=1520, yaw=0.06, pitch=0.085), pre=12, frames=135,
                      events={4: "g.disasters.trigger('nuke', new V(430, 0, -650)); g.rig.flyTo({distance: 2000, pitch: 0.06, yaw: 0.11}, 4.6)"},
                      aim=(40, 620), speed=lambda f: 1 if f < 45 else min(3.0, 1 + (f - 45) / 15)),
    'card-tsunami': dict(size=[1920, 1080], tod='golden', cam=None, frames=90,
                         setup="g.disasters.trigger('tsunami', new V(450, 0, -300))", pre=345,
                         after="let s = -300; while (!g.disasters.mask.isWater(450, s) && s < 3000) s += 10; g.rig.set({x: 470, z: s - 40, distance: 950, yaw: Math.PI + 0.42, pitch: 0.085}, true)",
                         events={}, aim=(70, 110), move=dict(distance=820, pitch=0.075, dur=3.0)),
    'card-meteor': dict(size=[1920, 1080], tod='golden', cam=dict(x=560, z=-80, distance=1550, yaw=0.38, pitch=0.12), frames=90,
                        setup="g.disasters.trigger('meteor', new V(600, 0, -250))", pre=42,
                        events={}, aim=(260, 200), move=dict(distance=1680, dur=3.0)),
    # the card's three beats (logo, tsunami, logo, meteor, logo, nuke, logo)
    'beat-tsunami': dict(size=[1920, 1080], tod='golden', cam=None, frames=66,
                         setup="g.disasters.trigger('tsunami', new V(450, 0, -300))", pre=426,
                         after="let s = -300; while (!g.disasters.mask.isWater(450, s) && s < 3000) s += 10; g.rig.set({x: 470, z: s - 60, distance: 700, yaw: Math.PI + 0.3, pitch: 0.24}, true); g.rig.aim = 30",
                         events={}, move=dict(distance=640, pitch=0.23, dur=2.2)),
    'beat-meteor': dict(size=[1920, 1080], tod='golden', cam=dict(x=560, z=-80, distance=1700, yaw=0.1, pitch=0.1), frames=80,
                        setup="g.rig.aim = 240; g.disasters.trigger('meteor', new V(600, 0, -250))", pre=45,
                        events={}, aim=(240, 260), move=dict(distance=1560, dur=2.7)),
    'beat-nuke': dict(size=[1920, 1080], tod='golden', cam=dict(x=260, z=330, distance=1700, yaw=0.08, pitch=0.075), pre=8, frames=128,
                      events={4: "Math.random = (() => { let x = 52711; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('nuke', new V(430, 0, -650)); g.rig.flyTo({distance: 2050, pitch: 0.075, yaw: 0.1}, 4.2)"},
                      aim=(330, 560), speed=lambda f: 1 if f < 36 else min(2.8, 1 + (f - 36) / 14)),
    # the nuke as a punch-in on the breakup: buildings blowing apart into chunks, the debris wave (seeded like the meteor)
    'beat-nuke-close': dict(size=[1920, 1080], tod='golden', cam=dict(x=520, z=-500, distance=1050, yaw=0.12, pitch=0.3), frames=66,
                            setup="g.rig.aim = 60; Math.random = (() => { let x = 52711; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('nuke', new V(430, 0, -650))", pre=24,
                            events={}, aim=(70, 150), move=dict(distance=960, pitch=0.28, dur=2.2)),
    # the meteor as two shots: the streak, then a punch-in on the impact
    'beat-meteor-wide': dict(size=[1920, 1080], tod='golden', cam=dict(x=560, z=-80, distance=1700, yaw=0.1, pitch=0.1), frames=21,
                             setup="g.rig.aim = 240; Math.random = (() => { let x = 86311; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('meteor', new V(600, 0, -250))", pre=51,
                             events={}, aim=(240, 250), move=dict(distance=1650, dur=0.7)),
    'beat-meteor-close': dict(size=[1920, 1080], tod='golden', cam=dict(x=600, z=-250, distance=950, yaw=0.16, pitch=0.2), frames=48,
                              setup="g.rig.aim = 90; Math.random = (() => { let x = 86311; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('meteor', new V(600, 0, -250))", pre=70,
                              events={}, aim=(90, 170), move=dict(distance=890, pitch=0.2, dur=1.6)),
    # the landing page's clips (2026-10-12 evening): longer, looping cuts of the physics-based disasters, from the beats
    'land-tsunami': dict(size=[1600, 900], tod='golden', cam=None, frames=150,
                         setup="g.disasters.trigger('tsunami', new V(450, 0, -300))", pre=405,
                         after="let s = -300; while (!g.disasters.mask.isWater(450, s) && s < 3000) s += 10; g.rig.set({x: 470, z: s - 60, distance: 820, yaw: Math.PI + 0.32, pitch: 0.25}, true); g.rig.aim = 30",
                         events={}, move=dict(distance=700, pitch=0.23, dur=5.0)),
    'land-nuke': dict(size=[1600, 900], tod='golden', cam=dict(x=260, z=330, distance=1700, yaw=0.08, pitch=0.075), pre=8, frames=200,
                      events={4: "Math.random = (() => { let x = 52711; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('nuke', new V(430, 0, -650)); g.rig.flyTo({distance: 2200, pitch: 0.08, yaw: 0.12}, 6.5)"},
                      aim=(330, 600), speed=lambda f: 1 if f < 36 else min(2.8, 1 + (f - 36) / 14)),
    'land-nuke-close': dict(size=[1600, 900], tod='golden', cam=dict(x=520, z=-500, distance=1050, yaw=0.12, pitch=0.3), frames=110,
                            setup="g.rig.aim = 60; Math.random = (() => { let x = 52711; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('nuke', new V(430, 0, -650))", pre=20,
                            events={}, aim=(60, 170), move=dict(distance=930, pitch=0.27, dur=3.7)),
    'land-meteor': dict(size=[1600, 900], tod='golden', cam=dict(x=560, z=-80, distance=1700, yaw=0.1, pitch=0.1), frames=130,
                        setup="g.rig.aim = 240; Math.random = (() => { let x = 86311; return () => (x = (x * 9301 + 49297) % 233280) / 233280 })(); g.disasters.trigger('meteor', new V(600, 0, -250))", pre=48,
                        events={}, aim=(240, 270), move=dict(distance=1500, dur=4.3)),
    'land-city': dict(size=[1600, 900], tod='golden', cam=dict(x=380, z=-300, distance=2300, yaw=-0.4, pitch=0.32), pre=10, frames=210,
                      events={}, move=dict(yaw=0.2, distance=2150, dur=7)),
    'land-night': dict(size=[1600, 900], tod='night', cam=dict(x=300, z=-200, distance=1700, yaw=0.5, pitch=0.3), pre=10, frames=180,
                       events={}, move=dict(yaw=0.85, distance=1550, pitch=0.28, dur=6)),
    'land-skyline': dict(size=[1600, 900], tod='golden', cam=dict(x=260, z=330, distance=1900, yaw=-0.1, pitch=0.07), pre=10, frames=210,
                         events={}, aim=(200, 200), move=dict(yaw=0.18, distance=1650, pitch=0.08, dur=7)),
}
name = cfg['shot']
shot = SHOTS[name]
out = f'/tmp/gp-rec/{name}'
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
w, h = shot['size']
tid = cdp("Target.createTarget", url="about:blank", newWindow=True)["targetId"]
try:
    switch_tab(tid)
    cdp("Page.bringToFront")
    cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
    cdp("Page.navigate", url="http://127.0.0.1:5280/play?film#toronto")
    for _ in range(240):
        time.sleep(0.5)
        try:
            cdp("Page.setWebLifecycleState", state="active")
            if js("!!window.__gp && window.__gp.frames > 20"): break
        except Exception:
            pass
    time.sleep(2)
    js(f"""(() => {{ const g = window.__gp; window.V = g.rig.focus.constructor; g.manual = true; g.setTimeOfDay('{shot['tod']}'); g.rig.enabled = true; return 1 }})()""")
    if shot.get('cam'):
        js(f"(() => {{ const g = window.__gp; g.rig.set({json.dumps(shot['cam'])}, true); for (let i = 0; i < 6; i++) g.advance(1/30); return 1 }})()")
    if shot.get('setup'):
        js(f"(() => {{ const g = window.__gp; const V = window.V; {shot['setup']}; return 1 }})()")
    pre = shot.get('pre', 0)
    while pre > 0:
        n = min(20, pre)
        js(f"(() => {{ for (let i = 0; i < {n}; i++) window.__gp.advance(1/30); return 1 }})()")
        pre -= n
    if shot.get('after'):
        js(f"(() => {{ const g = window.__gp; {shot['after']}; for (let i = 0; i < 3; i++) g.advance(1/30); return 1 }})()")
    if shot.get('move'):
        js(f"(() => {{ const g = window.__gp; g.rig.flyTo({json.dumps({k: v for k, v in shot['move'].items() if k != 'dur'})}, {shot['move']['dur']}); return 1 }})()")
    for f in range(shot['frames']):
        ev = shot['events'].get(f)
        if ev:
            js(f"(() => {{ const g = window.__gp; const V = window.V; {ev}; return 1 }})()")
        if shot.get('aim'):
            a0, a1 = shot['aim']
            js(f"window.__gp.rig.aim = {a0 + (a1 - a0) * min(1, f / max(1, shot['frames'] - 1))}")
        sp = shot.get('speed', lambda f: 1)(f)
        js(f"window.__gp.advance({sp / 30})")
        cdp("Page.setWebLifecycleState", state="active")
        # wait until the browser has actually presented that frame, or the capture can come back torn or black
        js("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))")
        import base64
        data = cdp("Page.captureScreenshot", format="jpeg", quality=93)["data"]
        open(f'{out}/{f:04d}.jpg', 'wb').write(base64.b64decode(data))
finally:
    cdp("Target.closeTarget", targetId=tid)
print('recorded', name, shot['frames'], 'frames')
