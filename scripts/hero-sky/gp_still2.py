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
cam = dict(x=300, z=-300, distance=4200, yaw=-0.1, pitch=0.012)
js(f"(() => {{ const g = window.__gp; g.manual = true; g.setTimeOfDay('golden'); g.rig.enabled = true; g.rig.set({json.dumps(cam)}, true); g.rig.cur.pitch = g.rig.goal.pitch = 0.012; g.rig.aim = 260; for (let i = 0; i < 8; i++) g.advance(1/30); return 1 }})()")
time.sleep(0.5)
capture_screenshot("/tmp/gp_still_full.png")
print(js("""(() => { const g = window.__gp; const out = []; g.scene.traverse(o => { if (o.isMesh || o.isPoints || o.isLine || o.isInstancedMesh) { const m = Array.isArray(o.material) ? o.material[0] : o.material; const sky = m && m.depthTest === false && o.frustumCulled === false; out.push([o.type, o.name, m && m.type, m && m.depthTest, o.frustumCulled, o.visible]); if (!sky) o.visible = false } }); for (let i = 0; i < 3; i++) g.advance(1/30); return JSON.stringify(out.slice(0, 40)) })()"""))
time.sleep(0.5)
capture_screenshot("/tmp/gp_still_sky.png")
close_tab(tid)
