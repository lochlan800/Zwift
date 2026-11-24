#!/usr/bin/env python3
"""Build src/data/features.json + src/data/landcover.bin from Overture parquet (+ LiDAR if present).
Run: python3 tools/build_features.py   (after tools/fetch_overture.py)
Frame: x = E-429500, z = 418400-N, y = AOD metres.  Grid 1501x1201 @4 m, row 0 = north.
"""
import os, sys, json, math, hashlib, heapq, collections
import numpy as np
import pyarrow.parquet as pq
from pyproj import Transformer
import shapely
from shapely import wkb
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, Point, box
from shapely.ops import substring
from shapely.strtree import STRtree
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
OV = os.path.join(ROOT, "data", "raw", "overture")
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "src", "data")
E0, N0 = 429500, 418400
EMIN, EMAX, NMIN, NMAX = 426500, 432500, 416000, 420800
XMIN, XMAX, ZMIN, ZMAX = EMIN - E0, EMAX - E0, N0 - NMAX, N0 - NMIN   # -3000..3000, -2400..2400
COLS, ROWS, RES = 1501, 1201, 4
AREA = box(XMIN, ZMIN, XMAX, ZMAX)
T = Transformer.from_crs(4326, 27700, always_xy=True)

# ---- route waypoints (local x,z, label) – snapped to nearest eligible road node, visited in order, loop closes
WAYPOINTS = json.load(open(os.path.join(HERE, "route_waypoints.json"))) if os.path.exists(os.path.join(HERE, "route_waypoints.json")) else []

def r1(v): return round(float(v), 1)

# ------------------------------------------------------------------ helpers
def load(name):
    return pq.read_table(os.path.join(OV, name + ".parquet")).to_pylist()

def to_local(g):
    """shapely geometry in lon/lat -> local metres (x,z)"""
    c = shapely.get_coordinates(g)
    e, n = T.transform(c[:, 0], c[:, 1])
    return shapely.set_coordinates(g, np.column_stack([np.asarray(e) - E0, N0 - np.asarray(n)]))

def polys(g):
    if g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    if isinstance(g, MultiPolygon): return list(g.geoms)
    if hasattr(g, "geoms"):
        return [p for s in g.geoms for p in polys(s)]
    return []

def lines(g):
    if g.is_empty: return []
    if isinstance(g, LineString): return [g]
    if hasattr(g, "geoms"):
        return [l for s in g.geoms for l in lines(s)]
    return []

def nm(rec):
    n = rec.get("names")
    return n.get("primary") if n else None

def densify(coords, step):
    coords = np.asarray(coords, float)
    out = [coords[0]]
    for a, b in zip(coords[:-1], coords[1:]):
        d = np.hypot(*(b - a)); k = int(math.ceil(d / step))
        for t in range(1, k + 1):
            out.append(a + (b - a) * t / k)
    return np.array(out)

def resample(coords, step, closed=False):
    c = np.asarray(coords, float)
    if closed: c = np.vstack([c, c[:1]])
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(c, axis=0).T))]
    L = d[-1]; n = max(2, int(round(L / step)))
    s = np.linspace(0, L, n + (0 if closed else 1), endpoint=not closed) if closed else np.linspace(0, L, n + 1)
    return np.column_stack([np.interp(s, d, c[:, 0]), np.interp(s, d, c[:, 1])]), L

def orient_ccw_from_top(ring):
    """ring in (x,z); viewed from +y (z points down the screen) CCW == negative shoelace in (x,z)."""
    a = 0.0
    for (x1, z1), (x2, z2) in zip(ring, ring[1:] + ring[:1]):
        a += x1 * z2 - x2 * z1
    return ring if a < 0 else ring[::-1]

# ------------------------------------------------------------------ LiDAR
class Lidar:
    def __init__(self):
        self.ok = False
        p1, p2 = os.path.join(RAW, "dtm_1m.npy"), os.path.join(RAW, "dsm_1m.npy")
        if not (os.path.exists(p1) and os.path.exists(p2)): return
        dtm = np.array(np.load(p1, mmap_mode="r"), dtype=np.float32)
        dsm = np.array(np.load(p2, mmap_mode="r"), dtype=np.float32)
        for a in (dtm, dsm):
            a[(a < -1000) | (a > 1000)] = np.nan
        bad = np.isnan(dtm)
        if bad.any():
            idx = ndi.distance_transform_edt(bad, return_distances=False, return_indices=True)
            dtm = dtm[tuple(idx)]
        dsm = np.where(np.isnan(dsm), dtm, dsm)
        dsm = np.maximum(dsm, dtm)  # nDSM never negative
        self.dtm, self.dsm, self.ok = dtm, dsm, True
        self.ndsm = dsm - dtm

    def sample(self, arr, x, z):
        x = np.asarray(x, float); z = np.asarray(z, float)
        return ndi.map_coordinates(arr, [np.clip(z + 2400 - 0.5, 0, 4799), np.clip(x + 3000 - 0.5, 0, 5999)],
                                   order=1, mode="nearest")

    def ground(self, x, z):
        return self.sample(self.dtm, x, z)

LID = None

def ground(x, z):
    if LID is not None and LID.ok:
        return LID.ground(x, z)
    return np.zeros_like(np.asarray(x, float))

def ma_smooth(y, n, closed=False):
    if len(y) < 2 or n < 2: return y
    return ndi.uniform_filter1d(y, size=n, mode="wrap" if closed else "reflect")

def profile(pts, spacing, flags=None, window=15.0, closed=False):
    """pts (N,2) -> y with smoothing; flagged points (bridge/tunnel) are interpolated between ends."""
    x, z = pts[:, 0], pts[:, 1]
    y = ground(x, z).astype(float)
    if LID is None or not LID.ok: return y
    raw = y.copy()
    if flags is not None and flags.any() and not flags.all():
        idx = np.arange(len(y))
        good = ~flags
        if closed:
            y = np.interp(idx, idx[good], y[good], period=len(y))
        else:
            y = np.interp(idx, idx[good], y[good])
    elif flags is not None and flags.all():
        y = np.linspace(raw[0], raw[-1], len(y))
    n = max(2, int(round(window / spacing)))
    ys = ma_smooth(y, n, closed)
    if not closed and len(y) > 2:   # pin ends to raw ground sample so junctions agree, ramp the correction
        s = np.arange(len(y)) * spacing
        d0 = (raw[0] if not (flags is not None and flags[0]) else y[0]) - ys[0]
        d1 = (raw[-1] if not (flags is not None and flags[-1]) else y[-1]) - ys[-1]
        ys = ys + d0 * np.clip(1 - s / window, 0, 1) + d1 * np.clip(1 - (s[-1] - s) / window, 0, 1)
    return ys

# ------------------------------------------------------------------ buildings
KMAP = {"house": "house", "detached": "house", "semidetached_house": "house", "bungalow": "house", "cabin": "house",
        "terrace": "terrace", "residential": "residential", "apartments": "residential", "dormitory": "residential",
        "hotel": "residential", "static_caravan": "shed",
        "commercial": "commercial", "office": "commercial", "service": "commercial", "entertainment": "commercial",
        "retail": "retail", "supermarket": "retail", "kiosk": "retail",
        "industrial": "industrial", "warehouse": "industrial", "factory": "industrial", "manufacture": "industrial",
        "church": "church", "chapel": "church", "religious": "church", "cathedral": "church", "mosque": "church",
        "synagogue": "church", "temple": "church",
        "school": "school", "university": "school", "college": "school", "kindergarten": "school", "education": "school",
        "garage": "garage", "garages": "garage", "carport": "garage", "parking": "garage",
        "shed": "shed", "outbuilding": "shed", "barn": "shed", "greenhouse": "shed", "farm_auxiliary": "shed",
        "hut": "shed", "agricultural": "shed", "stable": "shed", "cowshed": "shed", "roof": "shed", "shelter": "shed"}
DEF_H = {"house": 7.5, "terrace": 7.5, "residential": 9, "commercial": 8, "retail": 6, "industrial": 8,
         "church": 12, "school": 8, "garage": 2.8, "shed": 3, "other": 6}
ROOF_MAP = {"gabled": "gabled", "hipped": "hipped", "flat": "flat", "pyramidal": "hipped", "dome": "hipped",
            "round": "flat", "skillion": "gabled", "gambrel": "gabled", "mansard": "hipped", "half_hipped": "hipped",
            "saltbox": "gabled", "onion": "hipped", "cone": "hipped", "butterfly": "gabled"}

def build_buildings():
    recs = load("building")
    items = []
    for r in recs:
        if r.get("is_underground"): continue
        g = to_local(wkb.loads(r["geometry"]))
        for p in polys(g):
            if p.is_empty or not AREA.contains(p.centroid): continue
            p = p.simplify(0.3)
            if p.is_empty or p.area < 6: continue
            items.append((r, Polygon(p.exterior)))
    print("buildings after clip:", len(items))
    geoms = [p for _, p in items]
    # classes
    ks = []
    for r, p in items:
        c = (r.get("class") or "").lower(); s = (r.get("subtype") or "").lower()
        k = KMAP.get(c) or KMAP.get(s)
        if k is None:
            a = p.area
            k = "shed" if a < 20 else ("house" if a < 250 else "other")
        ks.append(k)
    # terrace detection among houses
    tree = STRtree(geoms)
    pairs = tree.query(geoms, predicate="dwithin", distance=0.3)
    nb = collections.Counter()
    for i, j in zip(*pairs):
        if i >= j: continue
        if ks[i] in ("house", "terrace") and ks[j] in ("house", "terrace"):
            if geoms[i].buffer(0.3).intersection(geoms[j].boundary).length > 1.5:
                nb[i] += 1; nb[j] += 1
    for i, n in nb.items():
        if n >= 2 and ks[i] == "house": ks[i] = "terrace"
    out = []
    for idx, ((r, p), k) in enumerate(zip(items, ks)):
        hid = int(hashlib.md5(r["id"].encode()).hexdigest()[:8], 16)
        a = p.area
        rs = ROOF_MAP.get((r.get("roof_shape") or "").lower())
        if rs is None:
            if k in ("house", "terrace", "residential", "church", "school"):
                rs = "hipped" if (k == "house" and a > 60 and hid % 4 == 0) else ("gabled" if a < 400 else "flat")
            elif k in ("commercial", "retail"): rs = "gabled" if a < 150 else "flat"
            elif k == "shed": rs = "gabled" if a > 12 else "flat"
            elif k == "industrial": rs = "flat" if a > 300 or hid % 2 else "gabled"
            else: rs = "flat" if a > 200 else "gabled"
        ring = [(float(x), float(z)) for x, z in p.exterior.coords[:-1]]
        ring = orient_ccw_from_top(ring)
        # fallback height
        h = r.get("height")
        if not h and r.get("num_floors"): h = r["num_floors"] * 3.0 + (2 if rs != "flat" else 0)
        if not h: h = DEF_H[k]
        mrr = p.minimum_rotated_rectangle
        if hasattr(mrr, "exterior"):
            cs = np.array(mrr.exterior.coords); w = sorted([np.hypot(*(cs[1] - cs[0])), np.hypot(*(cs[2] - cs[1]))])[0]
        else: w = 3.0
        out.append(dict(ring=ring, poly=p, k=k, r=rs, c=hid % 8, h0=float(h), w=float(w), id=r["id"]))
    return out

def finish_buildings(bl):
    res = []
    lid = LID is not None and LID.ok
    for b in bl:
        h, base = b["h0"], 0.0
        if lid:
            p = b["poly"]
            minx, minz, maxx, maxz = p.bounds
            u0, v0 = int(math.floor(minx + 3000)) - 1, int(math.floor(minz + 2400)) - 1
            u1, v1 = int(math.ceil(maxx + 3000)) + 1, int(math.ceil(maxz + 2400)) + 1
            u0, v0 = max(u0, 0), max(v0, 0); u1, v1 = min(u1, 6000), min(v1, 4800)
            def mask(poly):
                im = Image.new("L", (u1 - u0, v1 - v0), 0)
                if poly.is_empty: return np.zeros((v1 - v0, u1 - u0), bool)
                for q in polys(poly):
                    ImageDraw.Draw(im).polygon([(x + 3000 - u0, z + 2400 - v0) for x, z in q.exterior.coords], fill=1)
                return np.array(im, bool)
            m = mask(p)
            if m.any():
                dtm = LID.dtm[v0:v1, u0:u1]
                base = float(dtm[m].min())
                er = p.buffer(-1.0)
                me = mask(er) if not er.is_empty else m
                if me.sum() < 4: me = m
                dsm = LID.dsm[v0:v1, u0:u1][me]
                nd = LID.ndsm[v0:v1, u0:u1][me]
                if len(dsm) >= 4:
                    top = float(np.percentile(dsm, 90)) - base     # roof level above the (lowest) base
                    top = max(top, float(np.percentile(nd, 90)))
                    if top > 1.5: h = top
            else:
                base = float(LID.ground(p.centroid.x, p.centroid.y))
        h = min(max(h, 2.5), 40.0)
        if b["r"] == "flat": e = h
        else:
            rise = min(0.35 * b["w"], 4.5, 0.45 * h)
            e = max(h - rise, 2.2)
            if e >= h - 0.3: b["r"] = "flat"; e = h
        res.append({"p": [[r1(x), r1(z)] for x, z in b["ring"]], "h": r1(h), "e": r1(e), "b": r1(base),
                    "r": b["r"], "k": b["k"], "c": b["c"]})
    return res

# ------------------------------------------------------------------ roads / rail
WIDTH = {"primary": 7.3, "secondary": 6.5, "tertiary": 6.0, "unclassified": 5.5, "residential": 5.5,
         "service": 3.5, "track": 3.0, "cycleway": 2.5, "footway": 1.8, "path": 1.8, "steps": 1.5}
KROAD = {"motorway": "primary", "trunk": "primary", "primary": "primary", "secondary": "secondary",
         "tertiary": "tertiary", "unclassified": "unclassified", "residential": "residential",
         "living_street": "residential", "service": "service", "track": "track", "cycleway": "cycleway",
         "footway": "footway", "pedestrian": "footway", "path": "path", "bridleway": "path", "steps": "steps",
         "unknown": "service"}

def runs_from_flags(rec, col, vals):
    """list of (a,b) fraction ranges where any of vals flagged"""
    out = []
    for f in rec.get(col) or []:
        if set(f["values"]) & vals:
            b = f.get("between"); out.append((b[0], b[1]) if b else (0.0, 1.0))
    return out

def seg_kind_runs(rec):
    br = runs_from_flags(rec, "road_flags", {"is_bridge"}) + runs_from_flags(rec, "rail_flags", {"is_bridge"})
    tu = runs_from_flags(rec, "road_flags", {"is_tunnel", "is_covered"}) + runs_from_flags(rec, "rail_flags", {"is_tunnel", "is_covered"})
    for lr in rec.get("level_rules") or []:
        b = lr.get("between") or [0, 1]
        if lr["value"] > 0: br.append((b[0], b[1]))
        elif lr["value"] < 0: tu.append((b[0], b[1]))
    return br, tu

def split_by_runs(line, br, tu):
    """-> [(LineString, bridge, tunnel)] splitting a (local) line at flagged fraction ranges"""
    cuts = {0.0, 1.0}
    for a, b in br + tu: cuts |= {min(max(a, 0), 1), min(max(b, 0), 1)}
    cuts = sorted(cuts); L = line.length; out = []
    for a, b in zip(cuts[:-1], cuts[1:]):
        if b - a < 1e-6: continue
        m = (a + b) / 2
        sub = substring(line, a * L, b * L) if (b - a) < 0.9999 else line
        if sub.length < 0.5: continue
        out.append((sub, any(x <= m <= y for x, y in br), any(x <= m <= y for x, y in tu)))
    return out

def build_roads():
    recs = load("segment")
    roads, rail, graph_edges = [], [], []
    for r in recs:
        g = to_local(wkb.loads(r["geometry"]))
        if not isinstance(g, LineString): continue
        br, tu = seg_kind_runs(r)
        if r["subtype"] == "rail":
            if (r.get("class") or "") in ("abandoned", "disused", "razed"): continue
            for sub, b, t in split_by_runs(g, br, tu):
                for l in lines(sub.intersection(AREA)):
                    if l.length < 2: continue
                    pts = densify(l.simplify(0.3).coords, 4.0)
                    rail.append({"pts": pts, "br": b, "tu": t})
            continue
        cls = r.get("class") or "unknown"
        if cls not in KROAD: continue
        if r.get("subclass") in ("sidewalk", "crosswalk"): continue
        k = KROAD[cls]
        w = WIDTH[k] if cls != "motorway" else 9.0
        if r.get("subclass") == "driveway": w = 3.0
        for wr in r.get("width_rules") or []:
            if wr.get("value") and 1 <= wr["value"] <= 20 and not wr.get("between"):
                w = float(wr["value"]); break
        name = nm(r)
        for sub, b, t in split_by_runs(g, br, tu):
            for l in lines(sub.intersection(AREA)):
                if l.length < 2: continue
                pts = densify(l.simplify(0.3).coords, 4.0)
                roads.append({"k": k, "cls": cls, "w": w, "pts": pts, "n": name, "br": b, "tu": t})
    return roads, rail, recs

def finish_lines(items, closed=False):
    out = []
    for it in items:
        pts = it["pts"]
        fl = np.full(len(pts), bool(it.get("br") or it.get("tu")))
        y = profile(pts, 4.0, fl if fl.any() else None)
        d = {k: v for k, v in it.items() if k not in ("pts", "cls")}
        d["p"] = [[r1(x), r1(yy), r1(z)] for (x, z), yy in zip(pts, y)]
        d["br"] = 1 if it.get("br") else None; d["tu"] = 1 if it.get("tu") else None
        d = {k: v for k, v in d.items() if v is not None}
        out.append(d)
    return out

# ------------------------------------------------------------------ water
def build_water():
    recs = load("water")
    wpoly, wlines = [], []
    for r in recs:
        c = r.get("class"); st = r.get("subtype")
        if c == "sea" or st == "physical": continue
        g = to_local(wkb.loads(r["geometry"]))
        if isinstance(g, (Polygon, MultiPolygon)):
            for p in polys(g.intersection(AREA)):
                if p.area < 15: continue
                a = p.area
                if st == "river" or c == "river": k = "river"
                elif st == "canal": k = "canal"
                elif c in ("reservoir",): k = "reservoir"
                elif c == "pond" or c == "wastewater": k = "pond"
                elif c == "lake": k = "lake"
                else: k = "pond" if a < 3000 else "lake"
                wpoly.append({"k": k, "poly": p.simplify(0.5), "n": nm(r)})
        else:
            for l in lines(g.intersection(AREA)):
                if l.length < 3: continue
                kk = {"river": "river", "canal": "canal", "stream": "stream", "drain": "drain", "ditch": "drain"}.get(c, "stream")
                wlines.append({"k": kk, "line": l.simplify(0.5), "n": nm(r)})
    return wpoly, wlines

WW_W = {"river": 12, "canal": 8, "stream": 3, "drain": 1.5}

def finish_water(wpoly, wlines):
    water, ways = [], []
    cover = shapely.union_all([w["poly"].buffer(1.0) for w in wpoly]) if wpoly else Polygon()
    for w in wpoly:
        p = w["poly"]
        y = 0.0
        if LID is not None and LID.ok:
            minx, minz, maxx, maxz = p.bounds
            xs = np.arange(minx, maxx, 3.0); zs = np.arange(minz, maxz, 3.0)
            gx, gz = np.meshgrid(xs, zs); gx, gz = gx.ravel(), gz.ravel()
            ins = shapely.contains_xy(p, gx, gz)
            if ins.sum() >= 3: y = float(np.median(LID.ground(gx[ins], gz[ins])))
            else: y = float(LID.ground(p.centroid.x, p.centroid.y))
        rings = [[[r1(x), r1(z)] for x, z in p.exterior.coords[:-1]]]
        for h in p.interiors: rings.append([[r1(x), r1(z)] for x, z in h.coords[:-1]])
        d = {"k": w["k"], "p": rings, "y": r1(y)}
        if w["n"]: d["n"] = w["n"]
        water.append(d)
    for w in wlines:
        l = w["line"]
        if w["k"] in ("river", "canal"):   # drop lines inside polygons
            inside = l.intersection(cover).length / max(l.length, 1e-6)
            if inside > 0.6: continue
        if w["k"] in ("stream", "drain") and l.length < 15: continue
        pts = densify(l.coords, 4.0)
        y = profile(pts, 4.0, None, window=40.0)
        # waterways only flow downhill: running min along the line direction chosen by end heights
        if LID is not None and LID.ok and len(y) > 2:
            if y[0] < y[-1]: y = np.minimum.accumulate(y[::-1])[::-1]
            else: y = np.minimum.accumulate(y)
        d = {"k": w["k"], "w": WW_W[w["k"]], "p": [[r1(x), r1(yy), r1(z)] for (x, z), yy in zip(pts, y)]}
        if w["n"]: d["n"] = w["n"]
        ways.append(d)
    return water, ways

# ------------------------------------------------------------------ walls
def build_walls():
    recs = [r for r in load("infrastructure") if r["subtype"] == "barrier"]
    out = []
    for r in recs:
        k = {"fence": "fence", "wall": "wall", "retaining_wall": "wall", "city_wall": "wall", "hedge": "hedge"}.get(r["class"])
        if not k: continue
        g = to_local(wkb.loads(r["geometry"]))
        gl = [g.exterior] if isinstance(g, Polygon) else lines(g)
        for l in gl:
            for s in lines(l.intersection(AREA)):
                if s.length < 3: continue
                pts = densify(s.simplify(0.3).coords, 4.0)
                y = profile(pts, 4.0, None, window=8.0)
                out.append({"k": k, "p": [[r1(x), r1(yy), r1(z)] for (x, z), yy in zip(pts, y)]})
    return out

# ------------------------------------------------------------------ landcover
LU = {("agriculture", "farmland"): 1, ("agriculture", "meadow"): 0, ("agriculture", "farmyard"): 3,
      ("agriculture", "orchard"): 1, ("residential", None): 3, ("managed", "grass"): 0,
      ("recreation", "pitch"): 6, ("recreation", "recreation_ground"): 6, ("recreation", "playground"): 6,
      ("recreation", "track"): 6, ("recreation", None): 6, ("park", None): 6, ("golf", "bunker"): None,
      ("golf", None): 6, ("developed", "industrial"): 5, ("developed", "commercial"): 5,
      ("developed", "retail"): 5, ("developed", "brownfield"): 5, ("developed", None): 5,
      ("education", "school"): 6, ("education", "schoolyard"): 10, ("education", None): 3,
      ("horticulture", None): 8, ("cemetery", None): 9, ("religious", None): 3, ("transportation", None): 5,
      ("resource_extraction", None): 5, ("construction", None): 5, ("protected", None): 7}
LC = {"forest": 2, "shrub": 7, "crop": 1, "urban": 3, "barren": 7, "grass": 0, "wetland": 7, "mangrove": 2, "moss": 7, "snow": 0}
LAND = {"forest": 2, "wood": 2, "tree": 2, "shrub": 7, "scrub": 7, "grass": 0, "grassland": 0, "wetland": 7, "rock": 7, "stone": 7}
# draw order: lowest priority first -> highest last
PRIO = [0, 7, 1, 5, 3, 2, 8, 9, 6, 10, 4]

class Grid:
    def __init__(self):
        self.layers = {c: [] for c in range(11)}
    def add(self, cls, geom):
        for p in polys(geom): self.layers[cls].append(p)
    def render(self, img=None):
        img = img or Image.new("L", (COLS, ROWS), 0)
        for cls in PRIO:
            for p in self.layers[cls]:
                minx, minz, maxx, maxz = p.bounds
                u0 = max(int(math.floor((minx - XMIN) / RES)) - 1, 0); v0 = max(int(math.floor((minz - ZMIN) / RES)) - 1, 0)
                u1 = min(int(math.ceil((maxx - XMIN) / RES)) + 2, COLS); v1 = min(int(math.ceil((maxz - ZMIN) / RES)) + 2, ROWS)
                if u1 <= u0 or v1 <= v0: continue
                m = Image.new("L", (u1 - u0, v1 - v0), 0); d = ImageDraw.Draw(m)
                d.polygon([((x - XMIN) / RES - u0, (z - ZMIN) / RES - v0) for x, z in p.exterior.coords], fill=255)
                for h in p.interiors:
                    d.polygon([((x - XMIN) / RES - u0, (z - ZMIN) / RES - v0) for x, z in h.coords], fill=0)
                img.paste(cls, (u0, v0), m)
        return img

def build_landcover(buildings, wpoly, wlines):
    G = Grid(); G0 = Grid()   # G0: coarse land_cover base layer (big mosaic polygons skipped)
    for r in load("land_cover"):
        c = LC.get(r.get("subtype"))
        if c is None: continue
        for p in polys(to_local(wkb.loads(r["geometry"])).intersection(AREA)):
            if p.area > 3e5 and c in (1, 2, 7): continue
            G0.add(c, p)
    for r in load("land"):
        if r.get("class") in ("land", "island", "archipelago", "sea"): continue
        c = LAND.get(r.get("subtype")) if LAND.get(r.get("subtype")) is not None else LAND.get(r.get("class"))
        if c is None: continue
        g = wkb.loads(r["geometry"])
        if g.geom_type not in ("Polygon", "MultiPolygon"): continue
        G.add(c, to_local(g).intersection(AREA))
    for r in load("land_use"):
        key = (r["subtype"], r["class"])
        c = LU.get(key, LU.get((r["subtype"], None)))
        if c is None: continue
        G.add(c, to_local(wkb.loads(r["geometry"])).intersection(AREA))
    for r in load("infrastructure"):
        if r["class"] in ("parking",) and r["subtype"] == "transportation":
            g = wkb.loads(r["geometry"])
            if g.geom_type == "Polygon": G.add(10, to_local(g).intersection(AREA))
    for w in wpoly: G.add(4, w["poly"])
    for w in wlines:
        if w["k"] in ("river", "canal"): G.add(4, w["line"].buffer(WW_W[w["k"]] / 2.0))
    lc = np.array(G.render(G0.render()), np.uint8)
    # urban ground under/around buildings where the land-use layers left grass/farmland/scrub
    U = Grid()
    for b in buildings:
        U.add(5 if b["k"] == "industrial" else 3, b["poly"].buffer(6))
    for cls in (3, 5):
        pass
    ub = np.zeros((ROWS, COLS), np.uint8)
    ui = Image.new("L", (COLS, ROWS), 0)
    for cls in (3, 5):
        for p in U.layers[cls]:
            ImageDraw.Draw(ui).polygon([((x - XMIN) / RES, (z - ZMIN) / RES) for x, z in p.exterior.coords], fill=cls)
    ub = np.array(ui, np.uint8)
    sel = (ub > 0) & np.isin(lc, (0, 1, 7))
    lc[sel] = ub[sel]
    return lc

# ------------------------------------------------------------------ route graph
RCOST = {"secondary": 1.0, "tertiary": 1.0, "unclassified": 1.0, "residential": 1.15, "primary": 1.6,
         "trunk": 2.4, "living_street": 1.6}

def build_graph(recs):
    edges = []   # dict(u,v,len,line,cls,name,br,tu,fw,bw)
    for r in recs:
        cls = r.get("class")
        if r["subtype"] != "road" or cls not in RCOST: continue
        if r.get("subclass") in ("sidewalk", "crosswalk", "driveway", "parking_aisle", "alley"): continue
        if any(set(f["values"]) & {"is_tunnel", "is_covered"} for f in r.get("road_flags") or []): continue
        # access: deny whole segment if a plain "denied" w/o heading/vehicle (private etc.)
        fw = bw = True; blocked = False
        for a in r.get("access_restrictions") or []:
            w = a.get("when") or {}
            if a["access_type"] == "denied" and not w.get("during") and not w.get("vehicle") and not w.get("using") and not w.get("recognized"):
                mode = w.get("mode"); head = w.get("heading")
                if mode and "bicycle" not in mode: continue
                if head == "backward": bw = False
                elif head == "forward": fw = False
                elif not mode or "bicycle" in mode: blocked = True
        if blocked: continue
        g = to_local(wkb.loads(r["geometry"]))
        if not isinstance(g, LineString) or g.length < 1: continue
        br, tu = seg_kind_runs(r)
        if tu: continue
        cons = sorted(r["connectors"], key=lambda c: c["at"])
        L = g.length
        for a, b in zip(cons[:-1], cons[1:]):
            if a["connector_id"] == b["connector_id"] or b["at"] - a["at"] < 1e-6: continue
            sub = substring(g, a["at"] * L, b["at"] * L)
            if sub.length < 0.5: continue
            m = (a["at"] + b["at"]) / 2
            edges.append(dict(u=a["connector_id"], v=b["connector_id"], len=sub.length, line=np.array(sub.coords),
                              cls=cls, name=nm(r), br=any(x <= m <= y for x, y in br), fw=fw, bw=bw))
    # largest connected component
    adj = collections.defaultdict(list)
    for i, e in enumerate(edges):
        adj[e["u"]].append(e["v"]); adj[e["v"]].append(e["u"])
    seen = {}; comps = []
    for n in adj:
        if n in seen: continue
        st = [n]; seen[n] = len(comps); cnt = 0
        while st:
            a = st.pop(); cnt += 1
            for b in adj[a]:
                if b not in seen: seen[b] = len(comps); st.append(b)
        comps.append(cnt)
    big = int(np.argmax(comps))
    edges = [e for e in edges if seen[e["u"]] == big]
    return edges

def unit(v):
    n = np.hypot(*v); return v / n if n > 1e-9 else v

def route(edges, wps):
    nodes = {}
    for e in edges:
        nodes.setdefault(e["u"], e["line"][0]); nodes.setdefault(e["v"], e["line"][-1])
    ids = list(nodes); xy = np.array([nodes[i] for i in ids])
    nid_idx = {n: i for i, n in enumerate(ids)}
    out_edges = collections.defaultdict(list)    # node -> [(ei, dir)]
    for i, e in enumerate(edges):
        if e["fw"]: out_edges[e["u"]].append((i, 1))
        if e["bw"]: out_edges[e["v"]].append((i, -1))
    # bearings at start / end of each traversal
    def tang(i, d, at_end):
        l = edges[i]["line"] if d == 1 else edges[i]["line"][::-1]
        if at_end: a, b = l[-1], l[max(0, len(l) - 1 - 3)] if False else l[-2]
        return unit(l[-1] - l[-2]) if at_end else unit(l[1] - l[0])
    used = collections.Counter()
    def leg(src, dst, mult):
        start = (src, None)
        dist = {start: 0.0}; prev = {}; pq_ = [(0.0, 0, src, None)]; cnt = 0
        best = None
        while pq_:
            c, _, n, pe = heapq.heappop(pq_)
            if dist.get((n, pe), 1e18) < c: continue
            if n == dst: best = (n, pe); break
            for ei, d in out_edges[n]:
                if pe is not None and pe[0] == ei and pe[1] == -d: continue      # no immediate reversal
                e = edges[ei]
                cost = e["len"] * RCOST[e["cls"]]
                if used[ei]: cost *= mult
                if pe is not None:
                    ang = math.degrees(math.acos(np.clip(np.dot(tang(pe[0], pe[1], True), tang(ei, d, False)), -1, 1)))
                    if ang > 120: cost += 120
                    elif ang > 70: cost += 8
                nn = e["v"] if d == 1 else e["u"]
                st = (nn, (ei, d)); nc = c + cost
                if nc < dist.get(st, 1e18):
                    dist[st] = nc; prev[st] = (n, pe); cnt += 1
                    heapq.heappush(pq_, (nc, cnt, nn, (ei, d)))
        if best is None: raise RuntimeError("no path")
        seq = []; st = best
        while st in prev:
            seq.append(st[1]); st = prev[st]
        return seq[::-1]
    snapped = []
    major = collections.Counter()
    for e in edges:
        if e["cls"] in ("secondary", "tertiary", "primary", "trunk", "unclassified"):
            major[e["u"]] += 1; major[e["v"]] += 1
    deg = np.array([len(out_edges[i]) if major[i] >= 2 else 0 for i in ids])
    for x, z, lab in wps:
        d = np.hypot(xy[:, 0] - x, xy[:, 1] - z) + np.where(deg >= 3, 0, 1e6)   # junction nodes only (no dead-end spurs)
        snapped.append(ids[int(np.argmin(d))])
    full = []
    for a, b in zip(snapped, snapped[1:] + snapped[:1]):
        if a == b: continue
        s = leg(a, b, 6.0)
        for ei, d in s: used[ei] += 1
        full += s
    return full, snapped

def assemble_route(edges, seq):
    pts, flag, names = [], [], []
    for ei, d in seq:
        e = edges[ei]; l = e["line"] if d == 1 else e["line"][::-1]
        for k, p in enumerate(l):
            if pts and k == 0: continue
            pts.append(p); flag.append(e["br"])
        names.append((e["name"] or "(unnamed " + e["cls"] + ")", e["len"], e["cls"]))
    return np.array(pts), np.array(flag), names

def build_route(edges, wps):
    seq, snapped = route(edges, wps)
    pts, flag, names = assemble_route(edges, seq)
    # per-vertex flags -> resampled at 2 m
    d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    # close loop
    if np.hypot(*(pts[0] - pts[-1])) > 0.5:
        pts = np.vstack([pts, pts[:1]]); flag = np.r_[flag, flag[-1]]
        d = np.r_[0, np.cumsum(np.hypot(*np.diff(pts, axis=0).T))]
    L = d[-1]; n = int(round(L / 2.0)); s = np.arange(n) * L / n
    rp = np.column_stack([np.interp(s, d, pts[:, 0]), np.interp(s, d, pts[:, 1])])
    fl = np.interp(s, d, flag.astype(float)) > 0.5
    # smooth heading (circular gaussian, sigma 1.3 samples = 2.6 m), then re-space
    sm = np.column_stack([ndi.gaussian_filter1d(rp[:, 0], 1.3, mode="wrap"), ndi.gaussian_filter1d(rp[:, 1], 1.3, mode="wrap")])
    dev = np.hypot(*(sm - rp).T).max()
    seg = np.hypot(*(np.roll(sm, -1, 0) - sm).T); L2 = seg.sum()
    c = np.r_[0, np.cumsum(seg)]; n2 = int(round(L2 / 2.0)); s2 = np.arange(n2) * L2 / n2
    ext = np.vstack([sm, sm[:1]])
    fp = np.column_stack([np.interp(s2, c, ext[:, 0]), np.interp(s2, c, ext[:, 1])])
    fl2 = np.interp(s2, c, np.r_[fl, fl[0]].astype(float)) > 0.5
    y = profile(fp, L2 / n2, fl2 if fl2.any() else None, window=15.0, closed=True)
    return fp, y, L2, names, dev, snapped, seq

# ------------------------------------------------------------------ trees
def build_trees(buildings, roads, rail, wpoly, cap=60000):
    from scipy.spatial import cKDTree
    nd = ndi.gaussian_filter(LID.ndsm.astype(np.float32), 1.0)
    H, W = nd.shape
    mask = Image.new("L", (W, H), 0); dr = ImageDraw.Draw(mask)
    def drawp(p):
        dr.polygon([(x + 3000, z + 2400) for x, z in p.exterior.coords], fill=1)
    for b in buildings:
        for p in polys(b["poly"].buffer(1.5)): drawp(p)
    for r in roads:
        if r["k"] in ("footway", "path", "steps", "track", "cycleway", "service") and not r["br"]: continue
        for p in polys(LineString(r["pts"]).buffer(r["w"] / 2 + 0.7)): drawp(p)
    for r in rail:
        for p in polys(LineString(r["pts"]).buffer(3.5)): drawp(p)
    for w in wpoly:
        for p in polys(w["poly"].buffer(1.0)): drawp(p)
    m = np.array(mask, bool)
    mx = ndi.maximum_filter(nd, size=5)
    cand = (nd >= 3.0) & (nd == mx) & ~m
    vs, us = np.nonzero(cand)
    hv = nd[vs, us]
    order = np.argsort(-hv)
    vs, us, hv = vs[order], us[order], hv[order]
    pts = np.column_stack([us + 0.5, vs + 0.5])
    tree = cKDTree(pts)
    removed = np.zeros(len(pts), bool); keep = []
    for i in range(len(pts)):
        if removed[i]: continue
        keep.append(i)
        for j in tree.query_ball_point(pts[i], 4.0):
            if j > i: removed[j] = True
    keep = np.array(keep)
    pts, hv = pts[keep], hv[keep]
    # crown radius: mean distance along 8 rays where nDSM drops below 45 % of peak
    rad = np.zeros(len(pts)); steps = np.arange(0.5, 8.01, 0.5)
    acc = np.zeros(len(pts))
    for a in np.arange(8) * math.pi / 4:
        px = pts[:, 0, None] + np.cos(a) * steps[None]; pz = pts[:, 1, None] + np.sin(a) * steps[None]
        val = ndi.map_coordinates(nd, [np.clip(pz - 0.5, 0, H - 1), np.clip(px - 0.5, 0, W - 1)], order=1, mode="nearest")
        below = val < 0.45 * hv[:, None]
        first = np.where(below.any(1), below.argmax(1), len(steps) - 1)
        acc += steps[first]
    rad = np.clip(acc / 8.0, 1.0, 6.5)
    if len(pts) > cap:
        sel = np.argsort(-(hv * rad))[:cap]; pts, hv, rad = pts[sel], hv[sel], rad[sel]
    x = pts[:, 0] - 3000; z = pts[:, 1] - 2400
    y = LID.ground(x, z)
    return [[r1(a), r1(b), r1(c), r1(d), r1(e)] for a, b, c, d, e in zip(x, y, z, hv, rad)]

# ------------------------------------------------------------------ preview
def preview(lc, buildings, roads, rail, wpoly, ways, rte, path, scale=0.5, crop=None):
    cols = {0: (150, 190, 100), 1: (205, 200, 120), 2: (50, 110, 55), 3: (200, 195, 185), 4: (90, 150, 220),
            5: (170, 160, 175), 6: (120, 210, 120), 7: (140, 150, 90), 8: (170, 130, 90), 9: (110, 150, 110), 10: (150, 150, 150)}
    pal = np.zeros((256, 3), np.uint8)
    for k, v in cols.items(): pal[k] = v
    x0, z0, x1, z1 = crop if crop else (XMIN, ZMIN, XMAX, ZMAX)
    Wp, Hp = int((x1 - x0) * scale), int((z1 - z0) * scale)
    big = Image.fromarray(pal[lc]).resize((int(COLS * RES * scale), int(ROWS * RES * scale)), Image.NEAREST)
    img = big.crop((int((x0 - XMIN) * scale), int((z0 - ZMIN) * scale), int((x0 - XMIN) * scale) + Wp, int((z0 - ZMIN) * scale) + Hp))
    d = ImageDraw.Draw(img)
    P = lambda x, z: ((x - x0) * scale, (z - z0) * scale)
    for w in wpoly:
        for ring in w["p"] if "p" in w else [list(w["poly"].exterior.coords)]:
            d.polygon([P(*q[:2]) for q in ring], fill=(60, 120, 230))
    for w in ways:
        d.line([P(p[0], p[2]) for p in w["p"]], fill=(60, 120, 230), width=max(1, int(w["w"] * scale)))
    for r in rail: d.line([P(*p) for p in r["pts"]], fill=(60, 60, 60), width=max(1, int(2 * scale)))
    cw = {"primary": (240, 160, 60), "secondary": (250, 200, 80), "tertiary": (255, 255, 255), "unclassified": (255, 255, 255),
          "residential": (245, 245, 245), "service": (225, 225, 225)}
    for r in sorted(roads, key=lambda r: r["w"]):
        c = cw.get(r["k"], (190, 140, 110))
        d.line([P(*p) for p in r["pts"]], fill=c, width=max(1, int(r["w"] * scale)))
    for b in buildings:
        d.polygon([P(x, z) for x, z in b["ring"]], fill=(90, 80, 80))
    if rte is not None:
        d.line([P(x, z) for x, z in rte] + [P(*rte[0])], fill=(230, 20, 20), width=max(2, int(4 * scale)))
        d.ellipse([P(*rte[0])[0] - 5, P(*rte[0])[1] - 5, P(*rte[0])[0] + 5, P(*rte[0])[1] + 5], outline=(0, 0, 0))
    img.save(path)

# ------------------------------------------------------------------ main
def main():
    global LID
    LID = Lidar()
    print("LiDAR:", "found" if LID.ok else "NOT found -> y/b=0 and fallback heights, no trees")
    os.makedirs(OUT, exist_ok=True)
    bl = build_buildings()
    roads, rail, segrecs = build_roads()
    wpoly, wlines = build_water()
    lc = build_landcover(bl, wpoly, wlines)
    lc.tofile(os.path.join(OUT, "landcover.bin"))
    print("landcover counts:", {int(k): int(v) for k, v in zip(*np.unique(lc, return_counts=True))})
    buildings = finish_buildings(bl)
    froads = finish_lines(roads)
    frail = finish_lines(rail)
    water, ways = build_water_out = finish_water(wpoly, wlines)
    walls = build_walls()
    trees = build_trees(bl, roads, rail, wpoly) if LID.ok else []
    # route
    edges = build_graph(segrecs)
    print("route graph edges:", len(edges))
    rte = None; rd = None
    if WAYPOINTS:
        fp, y, L, names, dev, snapped, seq = build_route(edges, WAYPOINTS)
        rd = {"name": "Horbury Loop", "len": r1(L), "pts": [[r1(a), r1(c), r1(b)] for (a, b), c in zip(fp, y)]}
        rte = fp
        print(f"route length {L:.0f} m, smoothing deviation max {dev:.2f} m, points {len(fp)}")
        dy = np.diff(np.r_[y, y[:1]])
        print(f"climb {dy[dy>0].sum():.0f} m, min y {y.min():.1f}, max y {y.max():.1f}, max grade {100*np.abs(dy/ (L/len(fp))).max():.1f}%")
        # street list
        seqn = []
        for n, l, c in names:
            if seqn and seqn[-1][0] == n: seqn[-1][1] += l
            else: seqn.append([n, l, c])
        print("STREETS:", " > ".join(f"{n} ({l:.0f}m,{c[:3]})" for n, l, c in seqn))
        reuse = collections.Counter(frozenset([ei]) for ei, d in seq)
        print("edges used more than once:", sum(1 for v in reuse.values() if v > 1), "of", len(seq))
    feats = {"buildings": buildings,
             "roads": [d for d in froads], "rail": [{"p": d["p"], **({"br": 1} if d.get("br") else {})} for d in frail],
             "water": water, "waterways": ways, "trees": trees, "walls": walls}
    if rd: feats["route"] = rd
    for r in feats["roads"]: r.pop("tu", None) if not r.get("tu") else None
    with open(os.path.join(OUT, "features.json"), "w") as f:
        json.dump(feats, f, separators=(",", ":"), ensure_ascii=False)
    print({k: (len(v) if hasattr(v, "__len__") and k != "route" else "") for k, v in feats.items()})
    for fn in ("features.json", "landcover.bin"):
        print(fn, os.path.getsize(os.path.join(OUT, fn)) / 1e6, "MB")
    preview(lc, bl, roads, rail, wpoly, ways, rte, os.path.join(RAW, "features_preview.png"))
    preview(lc, bl, roads, rail, wpoly, ways, rte, os.path.join(RAW, "features_preview_town.png"), scale=1.0, crop=(-1800, -400, 1000, 1100))

if __name__ == "__main__":
    main()
