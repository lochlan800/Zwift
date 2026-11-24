# Horbury Ride — shared technical spec

A browser-based virtual cycling ride through the real area around **Horbury, Wakefield**.
v0.1 scope: a title screen with a **Ride** button; pressing it starts an automatic ride
along a real road loop through Horbury. Focus is **visual quality** (modern game look)
while staying smooth on a phone. No trainer / Bluetooth yet.

Deliverable: a **single self-contained HTML file** (`dist/index.html`) built with Vite +
`vite-plugin-singlefile`. All data is embedded. No network requests at runtime.

## Data sources (all open licence – attribution must appear on the title screen)
- Elevation: Environment Agency **LiDAR Composite DTM 1m** and **DSM (first return) 1m**
  via WCS at `environment.data.gov.uk/spatialdata/...` (Open Government Licence v3).
  - DTM coverage: `13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m`
    on `.../spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs`
  - DSM coverage: `df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m`
    on `.../spatialdata/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs`
  - Example GetCoverage (WCS 2.0.1, EPSG:27700, float32 GeoTIFF, big-endian):
    `?service=WCS&version=2.0.1&request=GetCoverage&coverageId=<ID>&subset=E(429000,430000)&subset=N(418000,419000)&format=image/tiff`
    (1 km tile at 1 m ≈ 4 MB; NODATA = -3.4028e38; read with `tifffile`.)
- Map features: **Overture Maps** release `2026-11-18.0` (contains OpenStreetMap data, ODbL),
  read with pyarrow from `s3://overturemaps-us-west-2/release/2026-11-18.0/theme=<t>/type=<y>/`
  (anonymous, region us-west-2; filter on the `bbox` struct columns xmin/xmax/ymin/ymax).
  Themes/types: `buildings/building`, `transportation/segment`, `base/water`, `base/land_use`,
  `base/land_cover`, `base/land`, `base/infrastructure`.
- Overpass/OSM tile servers are NOT reachable. DuckDB extensions are NOT downloadable.
- Python available: numpy, PIL, tifffile, pyproj, pyarrow, shapely may need `pip install`.

## Area & coordinate frame
- British National Grid (EPSG:27700) bbox: **E 426500 – 432500, N 416000 – 420800** (6.0 × 4.8 km).
- Local scene frame (metres, Three.js, Y up):
  - `x = E - 429500`
  - `z = 418400 - N`   (north is −z)
  - `y = height above Ordnance Datum (m)` — raw, no offset.
- Lon/lat → BNG with `pyproj.Transformer.from_crs(4326, 27700, always_xy=True)`.

## Data files (all in `src/data/`, imported by the app; keep total under ~10 MB)

### `meta.json`
```json
{ "E0":429500, "N0":418400, "Emin":426500, "Emax":432500, "Nmin":416000, "Nmax":420800,
  "res":4, "cols":1501, "rows":1201, "hMin":<float>, "hScale":0.01,
  "attribution":"…" }
```
Grid node (col i, row j): `E = Emin + i*res`, `N = Nmax - j*res`, i.e. local
`x = (Emin-E0) + i*res = -3000 + 4i`, `z = (N0-Nmax) + j*res = -2400 + 4j`.

### `height.bin` — terrain (bare earth DTM), 4 m grid
`Uint16` little-endian, `cols*rows` values, row-major, row 0 = north edge.
`h = hMin + value * hScale`. Values block-averaged from the 1 m DTM; NODATA filled
by interpolation (no holes). Water surfaces stay as LiDAR returned them.

### `landcover.bin` — Uint8, same grid as height
Class per node: `0` grass/pasture, `1` farmland/arable, `2` woodland/forest, `3` residential/urban
ground, `4` water, `5` industrial/commercial/brownfield, `6` park/recreation/sports pitch,
`7` scrub/heath/rough, `8` allotments/garden, `9` cemetery, `10` paved/car park.

### `features.json` (coords in local metres, rounded to 0.1)
```js
{
  "buildings": [ { "p": [[x,z],…],          // outer ring, no repeated closing point, CCW when viewed from +y
                   "h": 7.8,                // height of roof top above base (from LiDAR nDSM, fallback Overture/levels)
                   "e": 5.2,                // eave height above base (for pitched roofs; = h for flat)
                   "b": 52.3,               // base y (min DTM under footprint)
                   "r": "gabled"|"hipped"|"flat",
                   "k": "house"|"terrace"|"residential"|"commercial"|"retail"|"industrial"|"church"|"school"|"garage"|"shed"|"other",
                   "c": 0..7 }],            // stable per-building colour/material variant
  "roads":     [ { "k": "primary"|"secondary"|"tertiary"|"unclassified"|"residential"|"service"|"track"|"footway"|"cycleway"|"path"|"steps",
                   "w": 7.0,                // carriageway width m
                   "p": [[x,y,z],…],        // centreline, y = smoothed road surface height, ~4 m spacing
                   "n": "High Street",      // name (optional)
                   "br": 1, "tu": 1 }],     // bridge / tunnel flags (optional)
  "rail":      [ { "p": [[x,y,z],…], "br":1? } ],
  "water":     [ { "k": "river"|"canal"|"lake"|"pond"|"reservoir", "p": [[[x,z],…],…], "y": 22.1 } ],   // polygons (outer + holes), y = surface height
  "waterways": [ { "k": "river"|"canal"|"stream"|"drain", "w": 3, "p": [[x,y,z],…] } ],                 // line features without polygon
  "trees":     [ [x,y,z,h,r], … ],          // from LiDAR canopy (DSM−DTM) local maxima outside buildings/roads: base y, height, crown radius
  "walls":     [ { "k":"hedge"|"wall"|"fence", "p":[[x,y,z],…] } ],    // optional, if barrier data exists
  "route":     { "name":"Horbury Loop", "len": 9876.5, "pts": [[x,y,z],…] }  // ~2 m spacing, closed loop, y smoothed (gradients realistic, no spikes)
}
```

## App (src/) — owned by the renderer builder
- `index.html` title screen: name, short description, attribution, big **Ride** button.
- On Ride: camera chase-follows a procedurally modelled cyclist along `route.pts`;
  simple physics (fixed virtual 220 W rider, 75 kg + 8 kg bike, CdA 0.32, Crr 0.004),
  speed responds to gradient. HUD: speed, power, distance, gradient, elevation, time.
- Visual targets: physically based sky + sun, atmospheric fog/aerial perspective,
  soft shadows, PBR materials, terrain splatting by `landcover.bin` with procedural detail,
  real buildings with pitched roofs/brick/windows, road ribbons with markings and
  pavements, instanced LiDAR trees, water with reflections, grass near camera,
  tone mapping + subtle post (SMAA/FXAA, bloom, vignette).
- Must run on mobile (Android Chrome / iOS Safari): adaptive quality, DPR cap, chunked
  terrain LOD, frustum culling, instancing, ~60 fps target on mid-range phones.
