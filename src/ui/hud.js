// DOM HUD + mini elevation profile (updates throttled; no per-frame layout work)
export class Hud {
  constructor(route, name) {
    this.route = route;
    this.el = {
      speed: document.getElementById('hSpeed'), power: document.getElementById('hPower'), dist: document.getElementById('hDist'),
      grad: document.getElementById('hGrad'), elev: document.getElementById('hElev'), time: document.getElementById('hTime'),
    };
    document.getElementById('routeName').textContent = name;
    this.canvas = document.getElementById('profile');
    this.ctx = this.canvas.getContext('2d');
    this.bg = null;
    this.acc = 0;
    this.last = {};
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }
  resize() {
    const c = this.canvas, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, c.clientWidth), h = Math.max(10, c.clientHeight);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    this.bg = document.createElement('canvas'); this.bg.width = c.width; this.bg.height = c.height;
    const g = this.bg.getContext('2d');
    const r = this.route, W = c.width, H = c.height, pad = 6 * dpr, top = 18 * dpr;
    const mn = r.minY - 2, mx = r.maxY + 2;
    this._map = (s, y) => [pad + (s / r.length) * (W - 2 * pad), H - pad - ((y - mn) / (mx - mn)) * (H - pad - top)];
    const grd = g.createLinearGradient(0, top, 0, H);
    grd.addColorStop(0, 'rgba(255,190,90,0.85)'); grd.addColorStop(1, 'rgba(255,140,40,0.12)');
    g.beginPath();
    const N = 300;
    for (let k = 0; k <= N; k++) { const s = (k / N) * r.length; const [x, y] = this._map(s, r.smoothY(s)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.lineTo(W - pad, H); g.lineTo(pad, H); g.closePath();
    g.fillStyle = grd; g.fill();
    g.beginPath();
    for (let k = 0; k <= N; k++) { const s = (k / N) * r.length; const [x, y] = this._map(s, r.smoothY(s)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = 'rgba(255,220,160,0.95)'; g.lineWidth = 1.5 * dpr; g.stroke();
    g.fillStyle = 'rgba(220,230,245,0.7)'; g.font = `${9 * dpr}px system-ui, sans-serif`; g.textAlign = 'right';
    g.fillText(`${Math.round(r.maxY)} m`, W - pad, top - 4 * dpr);
    this.dpr = dpr;
    this.drawMarker(this._lastS || 0);
  }
  drawMarker(s) {
    this._lastS = s;
    if (!this.bg) return;
    const g = this.ctx, c = this.canvas;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(this.bg, 0, 0);
    const [x, y] = this._map(s, this.route.smoothY(s));
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, 0, x, c.height);
    g.beginPath(); g.arc(x, y, 5 * this.dpr, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.lineWidth = 2 * this.dpr; g.strokeStyle = '#ff8f2e'; g.stroke();
  }
  _set(k, v) { if (this.last[k] !== v) { this.last[k] = v; this.el[k].textContent = v; } }
  update(dt, st) {
    this.acc += dt;
    if (this.acc < 0.12) return;
    this.acc = 0;
    this._set('speed', (st.speed * 3.6).toFixed(1));
    this._set('power', String(Math.round(st.power)));
    this._set('dist', (st.dist / 1000).toFixed(2));
    const gp = st.grade * 100;
    this._set('grad', `${gp >= 0 ? '' : '−'}${Math.abs(gp).toFixed(1)}%`);
    this._set('elev', String(Math.round(st.elev)));
    this._set('time', fmtTime(st.time));
    this.drawMarker(st.s);
  }
}

export function fmtTime(t) {
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
