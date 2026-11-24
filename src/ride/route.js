import * as THREE from 'three';

// Closed-loop route with arc-length parameterisation.
export class Route {
  constructor(route) {
    let pts = route.pts.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[2] - a[i - 1][2]) > 0.05);
    const first = pts[0], lastP = pts[pts.length - 1];
    const closed = Math.hypot(first[0] - lastP[0], first[2] - lastP[2]) < 25;
    if (closed && Math.hypot(first[0] - lastP[0], first[2] - lastP[2]) < 0.05) pts = pts.slice(0, -1);
    this.closed = closed;
    const n = pts.length;
    this.n = n;
    this.x = new Float64Array(n); this.y = new Float64Array(n); this.z = new Float64Array(n); this.s = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { this.x[i] = pts[i][0]; this.y[i] = pts[i][1]; this.z[i] = pts[i][2]; }
    for (let i = 1; i <= n; i++) {
      const j = i % n;
      if (i === n && !closed) { this.s[n] = this.s[n - 1]; break; }
      this.s[i] = this.s[i - 1] + Math.hypot(this.x[j] - this.x[i - 1], this.y[j] - this.y[i - 1], this.z[j] - this.z[i - 1]);
    }
    this.length = closed ? this.s[n] : this.s[n - 1];
    // smoothed elevation for gradient display (+-12 m)
    this.ys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0, w = 0;
      for (let k = -6; k <= 6; k++) { const j = this._wrap(i + k); const ww = 7 - Math.abs(k); acc += this.y[j] * ww; w += ww; }
      this.ys[i] = acc / w;
    }
    this._seg = 0;
    let mn = Infinity, mx = -Infinity; for (const v of this.y) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    this.minY = mn; this.maxY = mx;
    let climb = 0; for (let i = 1; i < n; i++) climb += Math.max(0, this.ys[i] - this.ys[i - 1]);
    this.climb = climb;
  }
  _wrap(i) { const n = this.n; return this.closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)); }
  wrapS(s) { const L = this.length; return this.closed ? ((s % L) + L) % L : Math.max(0, Math.min(L - 1e-6, s)); }
  _find(s) {
    // monotone search starting from cached segment
    const S = this.s, n = this.n;
    let i = this._seg;
    if (!(S[i] <= s && s < S[i + 1])) {
      if (s >= S[i + 1]) { while (i < n - 1 && s >= S[i + 1]) i++; }
      else { while (i > 0 && s < S[i]) i--; }
      if (!(S[i] <= s && s <= S[i + 1])) { // binary fallback
        let lo = 0, hi = n - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m] <= s) lo = m; else hi = m - 1; }
        i = lo;
      }
    }
    return i;
  }
  // position at distance s -> out (Vector3); returns segment index
  at(s, out, cacheSeg = false) {
    s = this.wrapS(s);
    const i = this._find(s);
    if (cacheSeg) this._seg = i;
    const j = this._wrap(i + 1);
    const t = (s - this.s[i]) / Math.max(1e-6, this.s[i + 1] - this.s[i]);
    out.set(this.x[i] + (this.x[j] - this.x[i]) * t, this.y[i] + (this.y[j] - this.y[i]) * t, this.z[i] + (this.z[j] - this.z[i]) * t);
    return i;
  }
  smoothY(s) {
    s = this.wrapS(s);
    const i = this._find(s), j = this._wrap(i + 1);
    const t = (s - this.s[i]) / Math.max(1e-6, this.s[i + 1] - this.s[i]);
    return this.ys[i] + (this.ys[j] - this.ys[i]) * t;
  }
  gradient(s) { return (this.smoothY(s + 10) - this.smoothY(s - 10)) / 20; }
}

// Constant-power cyclist physics (SPEC): 220 W, 83 kg system, CdA 0.32, Crr 0.004
export class Physics {
  constructor() { this.P = 220; this.m = 83; this.CdA = 0.32; this.Crr = 0.004; this.rho = 1.225; this.v = 0.0; }
  step(dt, grade) {
    const g = 9.81, th = Math.atan(grade);
    let t = dt;
    while (t > 0) {
      const h = Math.min(t, 1 / 120); t -= h;
      const v = this.v;
      const F = 0.5 * this.rho * this.CdA * v * v + this.Crr * this.m * g * Math.cos(th) + this.m * g * Math.sin(th);
      const drive = this.P / Math.max(v, 1.5);
      this.v = Math.max(0.5, v + ((drive - F) / (this.m + 1.2)) * h);
    }
    return this.v;
  }
}

export const tmpV = new THREE.Vector3();
