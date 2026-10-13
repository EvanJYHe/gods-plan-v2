import json, time
w, h = 2400, 1100
tid = cdp("Target.createTarget", url="about:blank")["targetId"]
switch_tab(tid)
cdp("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
cdp("Page.navigate", url="http://127.0.0.1:5280/play?film#toronto")
for _ in range(240):
    time.sleep(0.5)
    try:
        cdp("Page.setWebLifecycleState", state="active")
        if js("!!window.__gp && window.__gp.frames > 20"): break
    except Exception: pass
time.sleep(2)
for name, tod, cam in [
    ('a', 'golden', dict(x=300, z=-300, distance=4200, yaw=-0.1, pitch=0.012)),
    ('b', 'day', dict(x=300, z=-300, distance=4200, yaw=-0.1, pitch=0.012)),
]:
    js(f"(() => {{ const g = window.__gp; g.manual = true; g.setTimeOfDay('{tod}'); g.rig.enabled = true; g.rig.set({json.dumps(cam)}, true); g.rig.cur.pitch = g.rig.goal.pitch = {cam['pitch']}; g.rig.aim = 260; for (let i = 0; i < 8; i++) g.advance(1/30); return 1 }})()")
    time.sleep(0.5)
    capture_screenshot(f"/tmp/gp_still_{name}.png")
print(js("document.querySelectorAll('canvas').length"))
close_tab(tid)
