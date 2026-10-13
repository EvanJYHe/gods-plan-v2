# God's Plan v2

A static god-simulator site: landing page at `/`, globe and Toronto sandbox at `/play`. Vite 8 + React 19 (UI) +
three.js 0.186 (raw). No backend. See `README.md` for commands and layout.

**Project memory:** `/Users/evanhe/repos/projects/project-vaults/gods-plan/` holds Evan's brief in his words, decisions,
references (Theoria, v1) and open questions. Read its `README.md` before changing direction, and record new feedback
there. The original team project (v1) is `~/repos/projects/shift`; its public demo is frozen, don't touch it.

## Commands

- `npm run dev` (port 5280), `npm run build` (typecheck + build), `npm run preview` (port 5281)
- `npm run data`: rebuild `public/data/toronto.json` from `~/repos/projects/shift/var/citypacks/toronto/`
- Footage: with the dev server up, write `{"shot": "<name>"}` to `/tmp/gp_rec.json` and run
  `BU_CDP_URL=http://127.0.0.1:9333 BU_NAME=gp-rec browser-harness < scripts/record.py`, then `bash scripts/encode.sh`

## Gotchas

- `window.__gp` is the engine in dev and prod (for checks): `__gp.disasters.trigger('nuke', new __gp.rig.focus.constructor(x, 0, z))`,
  `__gp.setTimeOfDay('night')`, `__gp.manual = true; __gp.advance(1/30)` steps exactly one frame.
- Scene coordinates: x east, y up, z **south** (z = -world z). The lake is +z.
- The renderer uses a reversed depth buffer: the sky draws first with depth test off (its shader pins it to the far
  plane, which is the near plane in reversed depth).
- Buildings are one mesh; per-building damage lives in `Buildings.state`/`state2` and is uploaded by `touch()`. Never
  rebuild the mesh for an effect.
- `browser-harness-ai` forces the shared daemon name `ai` (other agents use it too). For your own daemon on the
  dedicated browser use `BU_CDP_URL=http://127.0.0.1:9333 BU_NAME=<name> browser-harness`, and never `--reload` the
  shared one. Several heavy WebGL tabs make the browser time out: close your tabs when done.
- Nothing is committed, pushed or deployed without Evan asking.
