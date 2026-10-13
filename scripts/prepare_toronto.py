"""Compile the Toronto city pack from the original God's Plan repository into one compact JSON for the browser.

Input: ~/repos/projects/shift/var/citypacks/toronto/{world.json,massing.json} (OSM buildings and surfaces, the City of
Toronto's 3D Massing, the lake, roads and landmarks, in world metres: x east, z north, origin near Union Station).
Output: public/data/toronto.json. Coordinates are integer decimetres; polygons are simplified to 0.2 m.

Run with: npm run data
"""

import json
import math
import os
import pathlib
from collections import defaultdict

from shapely.geometry import Polygon, LineString

SRC = pathlib.Path(os.environ.get("SHIFT_PACK", pathlib.Path.home() / "repos/projects/shift/var/citypacks/toronto"))
OUT = pathlib.Path(__file__).resolve().parent.parent / "public/data/toronto.json"
TOL = 0.2  # metres


def pairs(flat):
    return list(zip(flat[0::2], flat[1::2]))


def q(points):
    """Quantize a ring to integer decimetres as a flat list, dropping repeated points."""
    out, last = [], None
    for x, z in points:
        p = (round(x * 10), round(z * 10))
        if p != last:
            out.extend(p)
            last = p
    if len(out) >= 4 and out[0] == out[-2] and out[1] == out[-1]:
        out = out[:-2]
    return out


def simplify_ring(flat, holes=None, tol=TOL):
    """Simplify a polygon (ring + holes); returns (ring, holes) as quantized flat lists, or None if degenerate."""
    try:
        poly = Polygon(pairs(flat), [pairs(h) for h in (holes or []) if len(h) >= 6])
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return None
        poly = poly.simplify(tol, preserve_topology=True)
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda p: p.area)
        if poly.area < 1.0:
            return None
        ring = q(list(poly.exterior.coords))
        hs = [q(list(i.coords)) for i in poly.interiors if Polygon(i).area > 2.0]
        if len(ring) < 6:
            return None
        return ring, [h for h in hs if len(h) >= 6]
    except Exception:
        return None


world = json.load(open(SRC / "world.json"))
massing = json.load(open(SRC / "massing.json"))
bx0, bz0, bx1, bz1 = world["crs"]["bounds_world"]

CATS = ["generic", "residential", "apartments", "retail", "utility", "civic", "office", "tower", "commercial", "hotel",
        "industrial", "landmark"]
cat_index = {c: i for i, c in enumerate(CATS)}

# The four modelled landmarks replace whatever OSM or the massing has at their footprint (the massing models the
# CN Tower as a 553 m cylinder, for instance).
from shapely.geometry import Point
MODELLED = {"cn_tower", "rogers_centre", "union_station", "scotiabank_arena"}
landmark_areas = [Polygon(pairs(l["ring"])).buffer(6) for l in world["landmarks"] if l["kind"] in MODELLED]


def under_landmark(ring):
    try:
        c = Polygon(pairs(ring)).representative_point()
    except Exception:
        return False
    return any(a.contains(c) for a in landmark_areas)


# Buildings: OSM footprints and reconciled sections. Sections of one source building share a group so the building
# collapses as one. Each record: [group, cat, base_dm, height_dm, ring, holes]
groups, buildings = {}, []
landmark_ids = {l["id"] for l in world["landmarks"]}
for b in world["buildings"]:
    if under_landmark(b["ring"]):
        continue
    key = b.get("source_id") or b["id"]
    g = groups.setdefault(key, len(groups))
    areas = b.get("roofs") or None
    base = b.get("base", 0) or 0
    h = b["h"] if (b.get("roofs") or b.get("base")) else max(b["h"], 3.0)
    s = simplify_ring(b["ring"], b.get("holes"))
    if not s:
        continue
    ring, holes = s
    buildings.append([g, cat_index.get(b.get("cat", "generic"), 0), round(base * 10), round(h * 10), ring, holes])

# Official massing: each building is a list of tiers [y0_dm, y1_dm, ring, holes]
mass = []
for m in massing["buildings"]:
    if m["tiers"] and under_landmark(m["tiers"][0]["ring"]):
        continue
    g = groups.setdefault("massing:" + str(m["id"]), len(groups))
    tiers = []
    for t in m["tiers"]:
        s = simplify_ring(t["ring"], t.get("holes"), tol=0.15)
        if not s:
            continue
        tiers.append([round(t["y0"] * 10), round(t["y1"] * 10), s[0], s[1]])
    if tiers:
        mass.append([g, cat_index.get(m.get("cat", "generic"), 0), tiers])

# Ground surfaces as polygons, by class, drawn in this order (later on top).
surfaces = {}
for cls in ["meadow", "ground", "grass", "sand", "rail", "pavement", "asphalt"]:
    out = []
    for s in world["surfaces"].get(cls, []):
        r = simplify_ring(s["ring"], s.get("holes"), tol=0.25)
        if r:
            out.append([r[0], r[1]] if r[1] else [r[0]])
    surfaces[cls] = out

# Water: the lake and harbour polygons.
water = []
for w in world["water"]:
    r = simplify_ring(w["ring"], w.get("holes"), tol=0.5)
    if r:
        water.append([r[0], r[1]] if r[1] else [r[0]])
far_water = []
for w in world["far_water"]:
    r = simplify_ring(w["ring"], w.get("holes"), tol=1.0)
    if r:
        far_water.append([r[0], r[1]] if r[1] else [r[0]])

# Major roads for traffic: centrelines of car roads, merged into long polylines where possible.
MAJOR = {"highway.primary", "highway.secondary", "highway.tertiary", "highway.trunk", "highway.primary_link",
         "highway.motorway", "highway.motorway_link", "highway.trunk_link"}
roads = []
for r in world["roads"]:
    if r["kind"] != "road" or r["type"] not in MAJOR or "car" not in r.get("allow", []):
        continue
    line = LineString(pairs(r["shape"]))
    if line.length < 25:
        continue
    line = line.simplify(0.5)
    roads.append([round(r["w"] * 10), round(r["speed"] * 10), q(list(line.coords))])

landmarks = [{"kind": l["kind"], "name": l["name"], "x": round(l["x"], 1), "z": round(l["z"], 1), "h": l["h"],
              "ring": q(pairs(l["ring"]))} for l in world["landmarks"]]

data = {
    "version": 2,
    "source": "God's Plan Toronto pack: OpenStreetMap (ODbL) and City of Toronto 3D Massing 2025 (Open Government Licence - Toronto)",
    "bounds": [bx0, bz0, bx1, bz1],
    "anchors": {a["name"]: [round(a["x"], 1), round(a["z"], 1)] for a in world["anchors"]},
    "categories": CATS,
    "groups": len(groups),
    "buildings": buildings,
    "massing": mass,
    "landmarks": landmarks,
    "surfaces": surfaces,
    "water": water,
    "farWater": far_water,
    "roads": roads,
}
OUT.write_text(json.dumps(data, separators=(",", ":")))
size = OUT.stat().st_size
pts = sum(len(b[4]) // 2 for b in buildings) + sum(len(t[2]) // 2 for m in mass for t in m[2])
spts = sum(len(p[0]) // 2 for v in surfaces.values() for p in v)
print(f"buildings {len(buildings)} + massing {len(mass)} ({sum(len(m[2]) for m in mass)} tiers), groups {len(groups)}, building points {pts}")
print("surfaces", {k: len(v) for k, v in surfaces.items()}, "points", spts)
print(f"water {len(water)} far {len(far_water)} roads {len(roads)} landmarks {len(landmarks)}")
print(f"wrote {OUT} ({size / 1e6:.2f} MB)")
