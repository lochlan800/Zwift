#!/usr/bin/env python3
"""LiDAR elevation pipeline for the Horbury Ride game.

Downloads EA LiDAR Composite DTM 1m and DSM (first return) 1m tiles over the
BNG bbox E 426500-432500, N 416000-420800 via WCS 2.0.1 GetCoverage, mosaics
them into 1 m float32 arrays, and resamples the DTM onto the 4 m game grid
described in SPEC.md (src/data/height.bin + src/data/meta.json).

Outputs:
  data/raw/tiles/{dtm,dsm}_{E}_{N}.tif   cached WCS tiles (E,N = tile SW corner)
  data/raw/dtm_1m.npy, data/raw/dsm_1m.npy   float32 (4800, 6000), row 0 = north
  data/raw/hillshade_preview.png
  src/data/height.bin, src/data/meta.json

Usage: python3 tools/fetch_lidar.py
"""

import json
import logging
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

logging.getLogger("tifffile").setLevel(logging.ERROR)

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
TILES = RAW / "tiles"
SRC_DATA = ROOT / "src" / "data"

# --- Area / grid constants (SPEC.md) ---------------------------------------
EMIN, EMAX = 426500, 432500
NMIN, NMAX = 416000, 420800
E0, N0 = 429500, 418400          # local scene origin
RES = 4
COLS, ROWS = 1501, 1201          # 4 m grid nodes
H_SCALE = 0.01
TILE = 1000
NODATA_THRESH = -100.0

ATTRIBUTION = (
    "Elevation: Environment Agency LiDAR Composite DTM/DSM 1m © Environment Agency "
    "copyright and/or database right 2026. Open Government Licence v3.0. Map data: "
    "© OpenStreetMap contributors (ODbL) via Overture Maps Foundation."
)

WCS_BASE = "https://environment.data.gov.uk/spatialdata"
PRODUCTS = {
    "dtm": (
        "lidar-composite-digital-terrain-model-dtm-1m",
        "13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m",
    ),
    "dsm": (
        "lidar-composite-digital-surface-model-first-return-dsm-1m",
        "df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m",
    ),
}

MAX_WORKERS = 3
RETRIES = 4                      # retries after the first attempt
CA_BUNDLE = "/root/.ccr/ca-bundle.crt"


def tile_list():
    """Yield (E0, N0, w, h) for each tile covering the bbox."""
    for e in range(EMIN, EMAX, TILE):
        for n in range(NMIN, NMAX, TILE):
            w = min(TILE, EMAX - e)
            h = min(TILE, NMAX - n)
            yield e, n, w, h


def wcs_url(product, e0, n0, w, h):
    path, cov = PRODUCTS[product]
    return (
        f"{WCS_BASE}/{path}/wcs?service=WCS&version=2.0.1&request=GetCoverage"
        f"&coverageId={cov}&subset=E({e0},{e0 + w})&subset=N({n0},{n0 + h})"
        f"&format=image/tiff"
    )


def is_tiff(path):
    with open(path, "rb") as f:
        magic = f.read(4)
    return magic in (b"II*\x00", b"MM\x00*") and os.path.getsize(path) > 1000


def curl_download(url, dest):
    tmp = dest.with_suffix(dest.suffix + ".part")
    cmd = ["curl", "-sS", "-f", "-g", "--connect-timeout", "30", "--max-time", "240", "-o", str(tmp)]
    if os.path.exists(CA_BUNDLE):
        cmd += ["--cacert", CA_BUNDLE]
    cmd.append(url)
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        if not is_tiff(tmp):
            raise RuntimeError("response is not a TIFF")
        os.replace(tmp, dest)
    finally:
        if tmp.exists():
            tmp.unlink()


def fetch_tile(product, e0, n0, w, h):
    dest = TILES / f"{product}_{e0}_{n0}.tif"
    if dest.exists() and is_tiff(dest):
        return dest, "cached"
    url = wcs_url(product, e0, n0, w, h)
    last = None
    for attempt in range(RETRIES + 1):
        try:
            curl_download(url, dest)
            return dest, f"downloaded (attempt {attempt + 1})"
        except (subprocess.CalledProcessError, RuntimeError, OSError) as exc:
            last = exc
            if attempt < RETRIES:
                time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"{product} tile E{e0} N{n0} failed after {RETRIES + 1} attempts: {last}")


def georef(page):
    """Return (x_origin_top_left, y_origin_top_left, sx, sy, epsg, raster_type)."""
    tags = page.tags
    if "ModelTransformationTag" in tags:
        m = tags["ModelTransformationTag"].value
        assert m[1] == 0 and m[4] == 0, "rotated tile not expected"
        x0, y0, sx, sy = m[3], m[7], m[0], m[5]
    else:
        tp = tags["ModelTiepointTag"].value
        ps = tags["ModelPixelScaleTag"].value
        sx, sy = ps[0], -ps[1]
        x0 = tp[3] - tp[0] * ps[0]
        y0 = tp[4] - tp[1] * sy
    gk = tags["GeoKeyDirectoryTag"].value
    keys = {gk[i]: gk[i + 3] for i in range(4, len(gk), 4)}
    return x0, y0, sx, sy, keys.get(3072), keys.get(1025)


def read_tile(path, e0, n0, w, h, verbose=False):
    with tifffile.TiffFile(path) as t:
        page = t.pages[0]
        x0, y0, sx, sy, epsg, rtype = georef(page)
        data = page.asarray().astype(np.float32)
    ok_geo = (
        abs(x0 - e0) < 1e-6 and abs(y0 - (n0 + h)) < 1e-6
        and abs(sx - 1.0) < 1e-9 and abs(sy + 1.0) < 1e-9
        and epsg == 27700 and data.shape == (h, w)
    )
    if verbose:
        print(f"  {path.name}: shape={data.shape} origin(TL)=({x0:.1f},{y0:.1f}) "
              f"pixel=({sx:+.0f},{sy:+.0f}) EPSG={epsg} rasterType={rtype} "
              f"[pix(0,0)=NW corner, rows S] ok={ok_geo}")
    if not ok_geo:
        raise RuntimeError(f"georef mismatch for {path.name}: origin ({x0},{y0}) "
                           f"shape {data.shape} expected ({h},{w}) at E{e0} N{n0}")
    return data


def iterative_fill(a, max_iter=20000):
    """Fill NaN cells by repeatedly averaging valid 8-neighbours."""
    a = a.copy()
    mask = np.isnan(a)
    it = 0
    while mask.any() and it < max_iter:
        valid = ~mask
        v = np.where(valid, a, 0.0).astype(np.float64)
        s = np.zeros_like(v)
        n = np.zeros(v.shape, np.float64)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if di == 0 and dj == 0:
                    continue
                sv = np.roll(np.roll(v, di, 0), dj, 1)
                sm = np.roll(np.roll(valid, di, 0), dj, 1).astype(np.float64)
                # zero wrapped borders
                if di == 1:
                    sv[0, :] = 0; sm[0, :] = 0
                if di == -1:
                    sv[-1, :] = 0; sm[-1, :] = 0
                if dj == 1:
                    sv[:, 0] = 0; sm[:, 0] = 0
                if dj == -1:
                    sv[:, -1] = 0; sm[:, -1] = 0
                s += sv
                n += sm
        fill = mask & (n > 0)
        a[fill] = (s[fill] / n[fill]).astype(np.float32)
        mask = np.isnan(a)
        it += 1
    if mask.any():
        # Fallback for very large voids: nearest valid cell.
        from scipy.ndimage import distance_transform_edt  # noqa: WPS433
        idx = distance_transform_edt(mask, return_distances=False, return_indices=True)
        a = a[idx[0], idx[1]]
    return a, it


def block_mean_4x4(a):
    """Mean over the 4x4 1 m cells centred on each 4 m node.

    Node (i,j) covers cell cols [4i-2, 4i+1] and rows [4j-2, 4j+1]
    (cell centres within +/-2 m of the node). Edges are clipped.
    """
    H, W = a.shape
    valid = ~np.isnan(a)
    v = np.where(valid, a, 0.0).astype(np.float64)
    # pad so that padded index = cell index + 2 and total = 4*nodes
    pr = 4 * ROWS - H            # 4804 - 4800 = 4 (2 top, 2 bottom)
    pc = 4 * COLS - W            # 6004 - 6000 = 4 (2 left, 2 right)
    P = np.pad(v, ((2, pr - 2), (2, pc - 2)))
    M = np.pad(valid.astype(np.float64), ((2, pr - 2), (2, pc - 2)))
    s = P.reshape(ROWS, 4, COLS, 4).sum(axis=(1, 3))
    n = M.reshape(ROWS, 4, COLS, 4).sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        return s / n


def hillshade(grid_m, dz_dx, dz_dy, az_deg=315.0, alt_deg=45.0):
    az = math.radians(az_deg)
    alt = math.radians(alt_deg)
    lx = math.cos(alt) * math.sin(az)
    ly = math.cos(alt) * math.cos(az)
    lz = math.sin(alt)
    nx, ny, nz = -dz_dx, -dz_dy, np.ones_like(dz_dx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    shade = (nx * lx + ny * ly + nz * lz) / norm
    return np.clip(shade, 0, 1)


def main():
    TILES.mkdir(parents=True, exist_ok=True)
    SRC_DATA.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    if shutil.which("curl") is None:
        sys.exit("curl is required")

    tiles = list(tile_list())
    print(f"Tiles: {len(tiles)} per product "
          f"({sum(1 for t in tiles if t[3] != TILE)} partial, "
          f"sizes {sorted(set((t[2], t[3]) for t in tiles))})")

    jobs = [(p, e, n, w, h) for p in ("dtm", "dsm") for (e, n, w, h) in tiles]
    t0 = time.time()
    results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(fetch_tile, *j): j for j in jobs}
        for fut in as_completed(futs):
            j = futs[fut]
            path, status = fut.result()          # raises on final failure
            results[j] = path
            print(f"  [{len(results):2d}/{len(jobs)}] {path.name}: {status}", flush=True)
    print(f"Download phase done in {time.time() - t0:.0f}s")

    # --- Read, verify georef, mosaic ----------------------------------------
    print("Verifying georeferencing and mosaicking...")
    arrays = {}
    for product in ("dtm", "dsm"):
        mos = np.full((NMAX - NMIN, EMAX - EMIN), np.nan, np.float32)
        covered = np.zeros(mos.shape, bool)
        for k, (e, n, w, h) in enumerate(tiles):
            path = results[(product, e, n, w, h)]
            data = read_tile(path, e, n, w, h, verbose=(k < 3 or k == len(tiles) - 1))
            r0 = NMAX - (n + h)
            c0 = e - EMIN
            mos[r0:r0 + h, c0:c0 + w] = data
            covered[r0:r0 + h, c0:c0 + w] = True
        assert covered.all(), "mosaic has uncovered cells"
        nodata = (mos < NODATA_THRESH) | ~np.isfinite(mos)
        mos[nodata] = np.nan
        arrays[product] = mos
        print(f"  {product}: shape {mos.shape}, NaN (nodata) cells before fill: "
              f"{int(np.isnan(mos).sum())}")

    dtm_raw_nan = int(np.isnan(arrays["dtm"]).sum())
    dsm_raw_nan = int(np.isnan(arrays["dsm"]).sum())

    # Seam check: compare column/row jumps across tile boundaries with typical jumps.
    def seam_report(a, name):
        dc = np.abs(np.diff(a, axis=1))
        dr = np.abs(np.diff(a, axis=0))
        # diff index k sits between cells k and k+1; tile edges are 1000 m multiples from EMIN/NMAX
        xb = [1000 * k - 1 for k in range(1, 6)]
        yb = [int(NMAX - (NMIN + 1000 * k)) - 1 for k in range(1, 5)]
        xb_mask = np.zeros(dc.shape[1], bool); xb_mask[xb] = True
        yb_mask = np.zeros(dr.shape[0], bool); yb_mask[yb] = True
        print(f"  {name} seam check (mean |jump| per 1 m step): "
              f"E-boundaries {np.nanmean(dc[:, xb_mask]):.4f} vs interior {np.nanmean(dc[:, ~xb_mask]):.4f}; "
              f"N-boundaries {np.nanmean(dr[yb_mask, :]):.4f} vs interior {np.nanmean(dr[~yb_mask, :]):.4f}")

    seam_report(arrays["dtm"], "DTM")

    # --- Fill ----------------------------------------------------------------
    t1 = time.time()
    dtm, it_dtm = iterative_fill(arrays["dtm"])
    print(f"DTM hole fill: {dtm_raw_nan} cells filled in {it_dtm} iterations ({time.time() - t1:.0f}s)")
    dsm_nan_mask = np.isnan(arrays["dsm"])
    dsm = np.where(dsm_nan_mask, dtm, arrays["dsm"]).astype(np.float32)
    clamped = int((dsm < dtm).sum())
    dsm = np.maximum(dsm, dtm).astype(np.float32)
    print(f"DSM hole fill from DTM: {dsm_raw_nan} cells; clamped DSM>=DTM on {clamped} cells")

    np.save(RAW / "dtm_1m.npy", dtm.astype(np.float32))
    np.save(RAW / "dsm_1m.npy", dsm)
    print(f"Wrote {RAW / 'dtm_1m.npy'} and {RAW / 'dsm_1m.npy'}")

    # --- 4 m terrain grid ----------------------------------------------------
    grid = block_mean_4x4(dtm).astype(np.float64)
    assert not np.isnan(grid).any()
    assert grid.shape == (ROWS, COLS)
    hmin = float(math.floor(grid.min()) - 1)
    vals = np.round((grid - hmin) / H_SCALE)
    over = int((vals > 65535).sum())
    vals = np.clip(vals, 0, 65535).astype("<u2")
    if over:
        print(f"WARNING: {over} nodes exceed Uint16 range; clipped")
    vals.tofile(SRC_DATA / "height.bin")

    meta = {
        "E0": E0, "N0": N0,
        "Emin": EMIN, "Emax": EMAX, "Nmin": NMIN, "Nmax": NMAX,
        "res": RES, "cols": COLS, "rows": ROWS,
        "hMin": hmin, "hScale": H_SCALE,
        "attribution": ATTRIBUTION,
    }
    (SRC_DATA / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {SRC_DATA / 'height.bin'} ({os.path.getsize(SRC_DATA / 'height.bin')} bytes) "
          f"and meta.json (hMin={hmin})")

    # Decode check
    dec = hmin + np.fromfile(SRC_DATA / "height.bin", dtype="<u2").reshape(ROWS, COLS) * H_SCALE
    print(f"Decode check: max |decoded - grid| = {np.abs(dec - grid).max():.4f} m")

    # --- Sanity summary ----------------------------------------------------
    print("\n== Summary ==")
    print(f"4 m grid height: min {dec.min():.2f}  max {dec.max():.2f}  mean {dec.mean():.2f} m")
    print(f"1 m DTM:         min {dtm.min():.2f}  max {dtm.max():.2f}  mean {dtm.mean():.2f} m")
    print(f"NaN before fill: DTM {dtm_raw_nan}, DSM {dsm_raw_nan}")

    def cell(a, E, N):
        c = int(math.floor(E - EMIN))
        r = int(math.floor(NMAX - N))
        return float(a[r, c])

    def node(E, N):
        i = int(round((E - EMIN) / RES))
        j = int(round((NMAX - N) / RES))
        return float(dec[j, i])

    for label, E, N, lo, hi in [
        ("Horbury centre", 429400, 418280, 60, 80),
        ("River Calder  ", 429300, 417300, 20, 30),
    ]:
        d = cell(dtm, E, N)
        s = cell(dsm, E, N)
        g = node(E, N)
        ok = "OK" if lo <= d <= hi else "CHECK"
        print(f"{label} E{E} N{N}: DTM1m {d:.2f}  DSM1m {s:.2f}  grid4m {g:.2f}  "
              f"expected {lo}-{hi} -> {ok}")

    # --- Hillshade preview -------------------------------------------------
    # dec is rows north->south, cols west->east. dz/dE per metre = d/dcol / 4,
    # dz/dN per metre = -(d/drow) / 4 (row index increases southwards).
    gcol = np.gradient(dec, axis=1) / RES
    grow = -np.gradient(dec, axis=0) / RES
    shade = hillshade(dec, gcol, grow)
    img = (shade * 255).astype(np.uint8)
    Image.fromarray(img, mode="L").save(RAW / "hillshade_preview.png", optimize=True)
    print(f"Wrote {RAW / 'hillshade_preview.png'} ({img.shape[1]}x{img.shape[0]})")


if __name__ == "__main__":
    main()
