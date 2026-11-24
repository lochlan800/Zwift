#!/usr/bin/env python3
"""Download Overture 2026-11-18.0 features covering the Horbury area -> data/raw/overture/<type>.parquet"""
import os, sys, time
import pyarrow.dataset as ds, pyarrow.fs as pafs, pyarrow.parquet as pq
import pyarrow.compute as pc
from pyproj import Transformer

REL = "2026-11-18.0"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "raw", "overture")
EMIN, EMAX, NMIN, NMAX = 426500, 432500, 416000, 420800
M = 100
TYPES = [("buildings", "building"), ("transportation", "segment"), ("transportation", "connector"),
         ("base", "water"), ("base", "land_use"), ("base", "land_cover"),
         ("base", "infrastructure"), ("base", "land")]

def main():
    os.makedirs(ROOT, exist_ok=True)
    t = Transformer.from_crs(27700, 4326, always_xy=True)
    xs, ys = [], []
    for e in (EMIN - M, EMAX + M):
        for n in (NMIN - M, NMAX + M):
            lo, la = t.transform(e, n); xs.append(lo); ys.append(la)
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    print("lonlat bbox", x0, y0, x1, y1)
    fs = pafs.S3FileSystem(anonymous=True, region="us-west-2")
    for theme, typ in TYPES:
        if len(sys.argv) > 1 and typ not in sys.argv[1:]:
            continue
        t0 = time.time()
        path = f"overturemaps-us-west-2/release/{REL}/theme={theme}/type={typ}/"
        d = ds.dataset(path, filesystem=fs, partitioning="hive")
        flt = ((pc.field("bbox", "xmin") <= x1) & (pc.field("bbox", "xmax") >= x0) &
               (pc.field("bbox", "ymin") <= y1) & (pc.field("bbox", "ymax") >= y0))
        tab = d.to_table(filter=flt)
        if typ == "segment" and "subtype" in tab.column_names:
            tab = tab.filter(pc.field("subtype").isin(["road", "rail", "water"]))
        out = os.path.join(ROOT, f"{typ}.parquet")
        pq.write_table(tab, out)
        print(f"{theme}/{typ}: {tab.num_rows} rows, {os.path.getsize(out)/1e6:.1f} MB, {time.time()-t0:.1f}s")
        for col in ("subtype", "class", "subclass"):
            if col in tab.column_names and tab.num_rows:
                vc = pc.value_counts(tab[col]).to_pylist()
                vc.sort(key=lambda v: -v["counts"])
                print("   ", col, [(v["values"], v["counts"]) for v in vc[:12]])

if __name__ == "__main__":
    main()
