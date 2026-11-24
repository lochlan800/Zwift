// Device tiering + dynamic resolution scaling.
export function detectTier() {
  const ua = navigator.userAgent || '';
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const small = Math.min(screen.width, screen.height) < 900;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (touch && small);
  const q = new URLSearchParams(location.search).get('q');
  let tier = mobile ? 'medium' : 'high';
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile && (cores <= 4 || (navigator.deviceMemory && navigator.deviceMemory <= 3))) tier = 'low';
  if (q === 'low' || q === 'medium' || q === 'high') tier = q;
  const T = {
    low: { tier: 'low', mobile, dprCap: 1.0, shadowMap: 1024, shadowFar: 140, treeNear: 90, maxNear: 900, grass: 0.45, lod: 0.7, smaa: false, bloom: true, msaa: 0, grassRadius: 18 },
    medium: { tier: 'medium', mobile, dprCap: 1.5, shadowMap: 1024, shadowFar: 200, treeNear: 140, maxNear: 1800, grass: 0.55, lod: 0.9, smaa: true, bloom: true, msaa: 0, grassRadius: 26 },
    high: { tier: 'high', mobile, dprCap: 2.0, shadowMap: 2048, shadowFar: 260, treeNear: 220, maxNear: 4000, grass: 1.0, lod: 1.25, smaa: true, bloom: true, msaa: 0, grassRadius: 36 },
  };
  return T[tier];
}

export class DynamicResolution {
  constructor(renderer, composerResize, cfg) {
    this.r = renderer; this.resize = composerResize; this.cfg = cfg;
    this.maxScale = 1; this.minScale = cfg.mobile ? 0.55 : 0.6;
    this.scale = 1; this.ft = 16.7; this.cool = 0;
    this.target = 1000 / 58; this.good = 0; this.upWait = 3000;
  }
  baseDpr() { return Math.min(window.devicePixelRatio || 1, this.cfg.dprCap); }
  current() { return this.baseDpr() * this.scale; }
  frame(dtMs) {
    if (dtMs > 250) return; // tab switch etc
    this.ft += (dtMs - this.ft) * 0.05;
    this.good = this.ft < this.target * 1.06 ? this.good + dtMs : 0;
    this.cool -= dtMs;
    if (this.cool > 0) return;
    let s = this.scale;
    if (this.ft > this.target * 1.2 && s > this.minScale) { s = Math.max(this.minScale, s - 0.08); this.upWait = Math.min(12000, this.upWait * 1.5); }
    else if (this.good > this.upWait && s < this.maxScale) { s = Math.min(this.maxScale, s + 0.05); this.good = 0; }
    if (s !== this.scale) { this.scale = s; this.resize(); this.cool = 1200; }
    else this.cool = 300;
  }
}
