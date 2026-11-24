// Terrain height grid + spatial helpers in the local scene frame (SPEC):
// node (i,j): x = x0 + i*res, z = z0 + j*res

export class HeightField {
  constructor(meta, height) {
    this.cols = meta.cols;
    this.rows = meta.rows;
    this.res = meta.res;
    this.x0 = meta.Emin - meta.E0;
    this.z0 = meta.N0 - meta.Nmax;
    this.h = height;
    this.width = (this.cols - 1) * this.res;
    this.depth = (this.rows - 1) * this.res;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < height.length; i++) { const v = height[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    this.minH = mn; this.maxH = mx;
  }

  at(i, j) {
    i = i < 0 ? 0 : i >= this.cols ? this.cols - 1 : i;
    j = j < 0 ? 0 : j >= this.rows ? this.rows - 1 : j;
    return this.h[j * this.cols + i];
  }

  // Height matching the full-resolution mesh triangulation
  // (quad split along the (i+1,j)-(i,j+1) diagonal).
  sample(x, z) {
    let fx = (x - this.x0) / this.res, fz = (z - this.z0) / this.res;
    fx = Math.min(Math.max(fx, 0), this.cols - 1.0001);
    fz = Math.min(Math.max(fz, 0), this.rows - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const u = fx - i, v = fz - j;
    const c = this.cols, h = this.h, k = j * c + i;
    const h00 = h[k], h10 = h[k + 1], h01 = h[k + c], h11 = h[k + c + 1];
    if (u + v < 1) return h00 + (h10 - h00) * u + (h01 - h00) * v;
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
}

// Uniform grid hash of 2D line segments (x,z) with a half-width.
export class SegmentIndex {
  constructor(cell = 32) {
    this.cell = cell;
    this.map = new Map();
    this.segs = []; // {ax,az,ay,bx,bz,by,hw,road}
  }
  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }
  add(ax, ay, az, bx, by, bz, hw, ref) {
    const s = { ax, ay, az, bx, by, bz, hw, ref, id: this.segs.length };
    this.segs.push(s);
    const c = this.cell;
    const x0 = Math.floor((Math.min(ax, bx) - hw) / c), x1 = Math.floor((Math.max(ax, bx) + hw) / c);
    const z0 = Math.floor((Math.min(az, bz) - hw) / c), z1 = Math.floor((Math.max(az, bz) + hw) / c);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = this._key(cx, cz);
      let a = this.map.get(k);
      if (!a) { a = []; this.map.set(k, a); }
      a.push(s);
    }
    return s;
  }
  // Nearest segment covering (x,z) with distance <= hw + margin. Returns {seg,d,t,y} or null.
  query(x, z, margin = 0, filter = null, out = { seg: null, d: 0, t: 0, y: 0 }) {
    const a = this.map.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!a) return null;
    let best = null, bestScore = Infinity;
    for (let n = 0; n < a.length; n++) {
      const s = a[n];
      if (filter && !filter(s)) continue;
      const dx = s.bx - s.ax, dz = s.bz - s.az;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = s.ax + dx * t - x, pz = s.az + dz * t - z;
      const d = Math.sqrt(px * px + pz * pz);
      const score = d - s.hw;
      if (score <= margin && score < bestScore) {
        bestScore = score; best = s;
        out.d = d; out.t = t; out.y = s.ay + (s.by - s.ay) * t;
      }
    }
    if (!best) return null;
    out.seg = best;
    return out;
  }
}

// Grid hash of polygons (buildings) for point-in-polygon tests.
export class PolygonIndex {
  constructor(cell = 32) { this.cell = cell; this.map = new Map(); }
  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }
  add(poly, ref) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of poly) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const e = { poly, ref, x0, x1, z0, z1 };
    const c = this.cell;
    for (let cx = Math.floor(x0 / c); cx <= Math.floor(x1 / c); cx++)
      for (let cz = Math.floor(z0 / c); cz <= Math.floor(z1 / c); cz++) {
        const k = this._key(cx, cz);
        let a = this.map.get(k);
        if (!a) { a = []; this.map.set(k, a); }
        a.push(e);
      }
  }
  // returns ref of the polygon containing (x,z) (expanded by margin via bbox only) or null
  find(x, z, margin = 0) {
    const a = this.map.get(this._key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!a) return null;
    for (let n = 0; n < a.length; n++) {
      const e = a[n];
      if (x < e.x0 - margin || x > e.x1 + margin || z < e.z0 - margin || z > e.z1 + margin) continue;
      if (margin > 0 || pointInPoly(x, z, e.poly)) return e.ref;
    }
    return null;
  }
}

export function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function hash2(x, z) {
  let h = Math.imul(Math.floor(x * 10) | 0, 374761393) ^ Math.imul(Math.floor(z * 10) | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// Cooperative time-slicing helper for heavy builds.
export class Slicer {
  constructor(budgetMs = 14) { this.budget = budgetMs; this.t = performance.now(); }
  async tick() {
    if (performance.now() - this.t > this.budget) { await nextFrame(); this.t = performance.now(); }
  }
}
