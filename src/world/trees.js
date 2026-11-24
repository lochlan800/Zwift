import * as THREE from 'three';
import { U, AERIAL_GLSL, GRID_GLSL, OCC_GLSL, patchMaterial } from './shared.js';
import { mulberry32, hash2 } from './heightfield.js';

// =====================================================================================
// Procedural trees: 6 species (oak, sycamore, ash, birch, beech, conifer), each with
//   LOD0  detailed model (branching trunk + limbs, many clustered leaf cards)
//   LOD1  medium model (fewer, bigger cards)
//   LOD2  baked impostor atlas (8 side views + 1 top view per species, painted at startup
//         from the very same model description with a 2D painter's algorithm).
// LODs cross-fade with screen-door dithering. Wind: trunk sway + per-card flutter.
// Art direction: clean, lush, slightly stylised crowns with a bright sunlit side.
// =====================================================================================

const SP_COUNT = 6;
const ATLAS_W = 1024, ATLAS_H = 1152;     // leaf cells 2x2 of 512, bark strip underneath
const CELL = 512, BARK_Y = 1024, BARK_H = 128;
const TILE = 128, VIEWS = 8;               // impostor tile size / side views (+1 top)
const BAKE_R0 = 0.38;                      // representative crown radius / height for baking
const BAKE_ELEV = 12 * Math.PI / 180;

// ------------------------------------------------------------------ species table
// colours are linear multipliers (vertex colours)
const SPECIES = [
  /* 0 oak      */ { cell: 0, leaf: [1.00, 1.00, 0.84], bark: [0.30, 0.23, 0.17], birch: 0, cy: 0.60, ry: 0.36, trunkTop: 0.42, trunkR: 0.050, limbs: 5, spread: 0.72, s0: 0.26, s1: 0.40 },
  /* 1 sycamore */ { cell: 1, leaf: [0.86, 1.02, 0.86], bark: [0.34, 0.30, 0.26], birch: 0, cy: 0.62, ry: 0.35, trunkTop: 0.44, trunkR: 0.042, limbs: 4, spread: 0.66, s0: 0.25, s1: 0.38 },
  /* 2 ash      */ { cell: 2, leaf: [1.08, 1.12, 0.80], bark: [0.34, 0.31, 0.27], birch: 0, cy: 0.64, ry: 0.38, trunkTop: 0.44, trunkR: 0.040, limbs: 5, spread: 0.62, s0: 0.24, s1: 0.37 },
  /* 3 birch    */ { cell: 2, leaf: [1.18, 1.18, 0.78], bark: [1.00, 1.00, 0.96], birch: 1, cy: 0.64, ry: 0.36, trunkTop: 0.50, trunkR: 0.030, limbs: 4, spread: 0.52, s0: 0.22, s1: 0.34 },
  /* 4 beech    */ { cell: 1, leaf: [0.94, 0.98, 0.78], bark: [0.52, 0.50, 0.47], birch: 0, cy: 0.58, ry: 0.38, trunkTop: 0.36, trunkR: 0.052, limbs: 5, spread: 0.74, s0: 0.27, s1: 0.42 },
  /* 5 conifer  */ { cell: 3, leaf: [0.66, 0.86, 0.74], bark: [0.30, 0.20, 0.14], birch: 0, cy: 0.5, ry: 0.5, trunkTop: 0.95, trunkR: 0.036, limbs: 0, spread: 0, s0: 0.3, s1: 0.4 },
];

// ------------------------------------------------------------------ atlas painter
function leafCell(g, ox, oy, rnd, o) {
  const S = CELL, cx = ox + S / 2, cy = oy + S / 2;
  const R = S * 0.5 * 0.9;
  const leaves = [];
  for (let i = 0; i < o.n; i++) {
    // irregular blob silhouette: radius limit varies with angle
    const a = rnd() * Math.PI * 2;
    const lim = R * (0.78 + 0.22 * Math.sin(a * 3 + o.phase) * Math.sin(a * 5 + 1.3 * o.phase) + 0.1 * Math.sin(a * 7));
    const rd = Math.sqrt(rnd());
    const x = Math.cos(a) * rd * lim, y = Math.sin(a) * rd * lim;
    leaves.push({ x, y, rot: Math.atan2(y, x) + (rnd() - 0.5) * 1.3, sz: o.size * (0.8 + rnd() * 0.5), rd, r: rnd(), a });
  }
  // dark underlayer first (fills gaps, gives depth), then lit leaves sorted dark->light
  for (let i = 0; i < leaves.length; i++) leaves[i].k = (-leaves[i].y / R) * 0.5 + 0.5 + (leaves[i].r - 0.5) * 0.55;
  leaves.sort((p, q) => p.k - q.k);
  const drawLeaf = (L, hsl, shade) => {
    g.save(); g.translate(cx + L.x, cy + L.y); g.rotate(L.rot);
    const w = L.sz, h = L.sz * o.aspect;
    g.fillStyle = `hsl(${hsl[0]},${hsl[1]}%,${hsl[2]}%)`;
    g.strokeStyle = `hsla(${hsl[0] + 4},${hsl[1] - 6}%,${Math.max(6, hsl[2] - 12)}%,0.9)`; g.lineWidth = 1.4;
    g.beginPath();
    if (o.shape === 'oak') {
      // lobed leaf: three overlapping ellipses along the leaf axis
      g.ellipse(w * 0.15, 0, w * 0.55, h * 0.8, 0, 0, 6.3);
      g.moveTo(w * 0.5 + w * 0.3, h * 0.2); g.ellipse(w * 0.45, h * 0.28, w * 0.34, h * 0.42, 0.5, 0, 6.3);
      g.moveTo(w * 0.45 + w * 0.3, -h * 0.2); g.ellipse(w * 0.45, -h * 0.28, w * 0.34, h * 0.42, -0.5, 0, 6.3);
    } else if (o.shape === 'ovate') {
      g.moveTo(-w * 0.5, 0); g.bezierCurveTo(-w * 0.2, -h, w * 0.5, -h * 0.7, w * 0.95, 0); g.bezierCurveTo(w * 0.5, h * 0.7, -w * 0.2, h, -w * 0.5, 0);
    } else {
      g.ellipse(0, 0, w * 0.9, h * 0.55, 0, 0, 6.3);
    }
    g.fill(); if (o.stroke) g.stroke();
    if (shade > 0.55 && o.vein) { g.strokeStyle = `hsla(${hsl[0] - 6},${hsl[1] - 8}%,${hsl[2] + 14}%,0.55)`; g.lineWidth = 1.2; g.beginPath(); g.moveTo(-w * 0.4, 0); g.lineTo(w * 0.8, 0); g.stroke(); }
    g.restore();
  };
  // underlayer
  for (let i = 0; i < leaves.length; i += 2) {
    const L = leaves[i];
    drawLeaf({ ...L, sz: L.sz * 1.1, x: L.x * 0.9, y: L.y * 0.9 }, [o.hue[0] + 4, o.sat - 6, o.light - 14], 0);
  }
  for (const L of leaves) {
    const hue = o.hue[0] + (o.hue[1] - o.hue[0]) * L.r;
    const l = o.light + (L.k - 0.5) * 17 + (L.r - 0.5) * 6;
    drawLeaf(L, [hue, o.sat + (L.k - 0.4) * 10, l], L.k);
  }
}

function needleCell(g, ox, oy, rnd) {
  const S = CELL, cx = ox + S / 2, cy = oy + S * 0.5;
  g.lineCap = 'round';
  const fr = 9;
  const items = [];
  for (let f = 0; f < fr; f++) {
    const a = (f / fr) * Math.PI * 2 + rnd() * 0.5;
    const len = 150 + rnd() * 75;
    items.push({ a, len, k: rnd() });
  }
  for (const it of items) {
    const dx = Math.cos(it.a), dy = Math.sin(it.a);
    g.strokeStyle = '#3a2a1c'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + dx * it.len, cy + dy * it.len); g.stroke();
    const steps = 26;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, px = cx + dx * it.len * t, py = cy + dy * it.len * t;
      const nl = (1.0 - t * 0.55) * 54 + 6;
      for (const sd of [-1, 1]) {
        const na = it.a + sd * (0.95 - t * 0.25) + (rnd() - 0.5) * 0.25;
        const l = 24 + 18 * t + rnd() * 8 + it.k * 6;
        g.strokeStyle = `hsl(${118 + rnd() * 24},${40 + rnd() * 10}%,${l}%)`; g.lineWidth = 5.2 - t * 1.6;
        g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); g.stroke();
      }
    }
  }
}

function makeAtlas() {
  const cv = document.createElement('canvas'); cv.width = ATLAS_W; cv.height = ATLAS_H;
  const g = cv.getContext('2d');
  const rnd = mulberry32(4242);
  // 0 oak (lobed), 1 broad (sycamore/beech), 2 small leaflets (ash/birch), 3 conifer sprays
  leafCell(g, 0, 0, rnd, { n: 260, size: 27, aspect: 0.7, hue: [92, 114], sat: 50, light: 31, shape: 'oak', phase: 0.3, stroke: true, vein: false });
  leafCell(g, CELL, 0, rnd, { n: 230, size: 34, aspect: 0.6, hue: [96, 118], sat: 48, light: 30, shape: 'ovate', phase: 1.1, stroke: true, vein: true });
  leafCell(g, 0, CELL, rnd, { n: 520, size: 21, aspect: 0.55, hue: [88, 108], sat: 52, light: 33, shape: 'small', phase: 2.2, stroke: false, vein: false });
  needleCell(g, CELL, CELL, rnd);
  // bark strip
  g.fillStyle = '#cfcac2'; g.fillRect(0, BARK_Y, 512, BARK_H);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(50,44,38,${0.12 + rnd() * 0.3})`;
    g.fillRect(rnd() * 512, BARK_Y, 1.5 + rnd() * 6, BARK_H);
  }
  g.fillStyle = '#f2f0ec'; g.fillRect(512, BARK_Y, 512, BARK_H);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(150,148,142,${0.1 + rnd() * 0.2})`;
    g.fillRect(512 + rnd() * 512, BARK_Y, 1 + rnd() * 5, BARK_H);
  }
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(28,26,24,${0.55 + rnd() * 0.4})`;
    g.fillRect(512 + rnd() * 500, BARK_Y + rnd() * (BARK_H - 8), 14 + rnd() * 70, 2 + rnd() * 4);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, cv };
}

// ------------------------------------------------------------------ model description
// Unit tree: base y=0, total height 1, crown horizontal radius 1.
// A model = { segs: [[x0,y0,z0,x1,y1,z1,r0,r1,sides]], cards: [{c,ax,ay,s,ao,col}], sp }
const V = (x, y, z) => ({ x, y, z });
const norm3 = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return V(v.x / l, v.y / l, v.z / l); };
const cross3 = (a, b) => V(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

function cardAxes(nc, rnd) {
  const up = Math.abs(nc.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0);
  let ax = norm3(cross3(nc, up));
  const ay0 = cross3(nc, ax);
  const roll = rnd() * Math.PI * 2, cs = Math.cos(roll), sn = Math.sin(roll);
  const a2 = V(ax.x * cs + ay0.x * sn, ax.y * cs + ay0.y * sn, ax.z * cs + ay0.z * sn);
  const b2 = V(-ax.x * sn + ay0.x * cs, -ax.y * sn + ay0.y * cs, -ax.z * sn + ay0.z * cs);
  return [a2, b2];
}

function buildDeciduous(sp, lod, tier) {
  const S = SPECIES[sp];
  const rnd = mulberry32(1000 + sp * 77 + lod * 13);
  const segs = [], cards = [];
  const hi = lod === 0;
  const sides = hi ? 7 : 5;
  const { cy, ry, trunkTop: tT, trunkR: tr } = S;
  const lean = (rnd() - 0.5) * 0.06, lean2 = (rnd() - 0.5) * 0.06;
  // flared base + trunk
  segs.push([0, -0.05, 0, 0, 0.06, 0, tr * 1.55, tr * 1.1, sides, 0]);
  segs.push([0, 0.06, 0, lean, tT * 0.5, lean2, tr * 1.1, tr * 0.85, sides, 0]);
  segs.push([lean, tT * 0.5, lean2, lean * 1.4, tT, lean2 * 1.4, tr * 0.85, tr * 0.6, sides, 0]);
  const top = V(lean * 1.4, tT, lean2 * 1.4);
  const tips = [];
  const nl = hi ? S.limbs : Math.max(3, S.limbs - 1);
  const a0 = rnd() * 6.28;
  for (let i = 0; i < nl; i++) {
    const a = a0 + (i / nl) * Math.PI * 2 + (rnd() - 0.5) * 0.6;
    const d = S.spread * (0.75 + rnd() * 0.35);
    const sy = tT * (0.62 + rnd() * 0.36);
    const st = V(top.x * (sy / tT), sy, top.z * (sy / tT));
    const mid = V(Math.cos(a) * d * 0.45, sy + (cy - sy) * 0.45 + 0.02, Math.sin(a) * d * 0.45);
    const tip = V(Math.cos(a) * d, cy + (rnd() - 0.15) * ry * 0.7, Math.sin(a) * d);
    const lr = tr * 0.5;
    segs.push([st.x, st.y, st.z, mid.x, mid.y, mid.z, lr, lr * 0.72, hi ? 5 : 4, 0]);
    segs.push([mid.x, mid.y, mid.z, tip.x, tip.y, tip.z, lr * 0.72, lr * 0.4, hi ? 5 : 4, 0]);
    tips.push(tip);
    if (hi) {
      const nt = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < nt; k++) {
        const b = a + (k - (nt - 1) / 2) * 0.9 + (rnd() - 0.5) * 0.4;
        const t2 = V(tip.x + Math.cos(b) * 0.2, tip.y + 0.04 + rnd() * ry * 0.45, tip.z + Math.sin(b) * 0.2);
        segs.push([tip.x, tip.y, tip.z, t2.x, t2.y, t2.z, lr * 0.4, lr * 0.2, 4, 0]);
        tips.push(t2);
      }
    }
  }
  // central leader tip
  tips.push(V(top.x, cy + ry * 0.5, top.z));
  segs.push([top.x, top.y, top.z, top.x, cy + ry * 0.5, top.z, tr * 0.5, tr * 0.2, 4, 0]);

  const nCards = tier.cards;
  const size = hi ? S.s0 : S.s1;
  const inCrown = (p) => { const q = ((p.x) / 1.0) ** 2 + ((p.y - cy) / ry) ** 2 + (p.z / 1.0) ** 2; return q; };
  const addCard = (p, outward, jit) => {
    // clamp inside crown ellipsoid (slightly generous)
    const q = inCrown(p);
    if (q > 1.08) { const k = 1.04 / Math.sqrt(q); p = V(p.x * k, cy + (p.y - cy) * k, p.z * k); }
    const sph = norm3(V(p.x, (p.y - cy) / ry * 0.8, p.z));
    const nc = norm3(V(sph.x + (rnd() - 0.5) * jit, sph.y + (rnd() - 0.5) * jit + 0.1, sph.z + (rnd() - 0.5) * jit));
    const [ax, ay] = cardAxes(rnd() < outward ? nc : norm3(V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5)), rnd);
    const depth = Math.min(1, Math.sqrt(Math.min(1.2, inCrown(p))));
    const yn = (p.y - cy) / ry;
    let ao = 0.30 + 0.72 * Math.pow(depth, 0.9);
    ao *= 0.78 + 0.22 * Math.min(1, Math.max(0, (yn + 1) / 1.6));
    cards.push({ c: p, ax, ay, s: size * (0.85 + rnd() * 0.3), ao: Math.min(1, ao), n: sph, hue: [0.92 + rnd() * 0.16, 0.94 + rnd() * 0.1, 0.9 + rnd() * 0.16] });
  };
  // clusters around branch tips (reads as branching), rest fills the outer shell
  const perTip = hi ? 5 : 3;
  let used = 0;
  for (const t of tips) {
    for (let k = 0; k < perTip && used < nCards * 0.55; k++, used++) {
      const o = V((rnd() - 0.5) * 0.5, (rnd() - 0.4) * ry * 0.7, (rnd() - 0.5) * 0.5);
      addCard(V(t.x + o.x, t.y + o.y, t.z + o.z), 0.8, 0.5);
    }
  }
  while (cards.length < nCards) {
    let p;
    do { p = V(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); } while (p.x * p.x + p.y * p.y + p.z * p.z > 1);
    const l = Math.hypot(p.x, p.y, p.z) || 1;
    const rr = 0.55 + 0.45 * Math.pow(rnd(), 0.45);
    // flatter underside: lift points below the crown centre
    const py = p.y / l * rr;
    addCard(V(p.x / l * rr, cy + (py < 0 ? py * 0.8 : py) * ry, p.z / l * rr), 0.85, 0.45);
  }
  return { segs, cards, sp };
}

function buildConifer(sp, lod, tier) {
  const S = SPECIES[sp];
  const rnd = mulberry32(555 + lod * 31);
  const segs = [], cards = [];
  const hi = lod === 0;
  segs.push([0, -0.05, 0, 0, 0.1, 0, S.trunkR * 1.5, S.trunkR * 1.1, hi ? 7 : 5, 0]);
  segs.push([0, 0.1, 0, 0.005, 0.97, 0, S.trunkR * 1.1, S.trunkR * 0.2, hi ? 7 : 5, 0]);
  const tiers = tier.tiers;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 0.09 + f * 0.84;
    const rad = Math.pow(1 - f, 0.85) * 0.92 + 0.07;
    const n = Math.max(3, Math.round(tier.ring * (1 - f))) + 2;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.8 + t * 0.6;
      const rr = rad * (0.45 + rnd() * 0.15);
      const p = V(Math.cos(a) * rr, y + (rnd() - 0.5) * 0.02, Math.sin(a) * rr);
      const ax = norm3(V(Math.cos(a), -0.45, Math.sin(a)));
      const ay = V(-Math.sin(a), 0, Math.cos(a));
      const nn = norm3(V(p.x, 0.5 * (0.2 + rad), p.z));
      const ao = 0.34 + 0.66 * Math.min(1, Math.pow(rr / (rad * 0.62 + 1e-3), 1.2)) * (0.8 + 0.2 * f);
      cards.push({ c: p, ax, ay, s: (rad * 0.5 + 0.1) * (hi ? 1 : 1.2), ao: Math.min(1, ao), n: nn, hue: [0.9 + rnd() * 0.2, 0.95 + rnd() * 0.1, 0.9 + rnd() * 0.15], tipUp: true });
    }
  }
  return { segs, cards, sp };
}

function buildModel(sp, lod, tierName) {
  const hiDetail = tierName !== 'low';
  const t = sp === 5
    ? (lod === 0 ? { tiers: hiDetail ? 11 : 8, ring: 9 } : { tiers: 7, ring: 6 })
    : (lod === 0 ? { cards: hiDetail ? 150 : 100 } : { cards: hiDetail ? 62 : 44 });
  return sp === 5 ? buildConifer(sp, lod, t) : buildDeciduous(sp, lod, t);
}

// ------------------------------------------------------------------ geometry from model
function modelGeometry(model) {
  const S = SPECIES[model.sp];
  const pos = [], nor = [], uv = [], col = [], aT = [], aC = [], idx = [];
  const bark = S.bark;
  const bu0 = S.birch ? 0.5 : 0.0;
  const bv0 = 1 - (BARK_Y + BARK_H * 0.1) / ATLAS_H, bv1 = 1 - (BARK_Y + BARK_H * 0.9) / ATLAS_H;
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpD = new THREE.Vector3(), tmpU = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpT = new THREE.Vector3();
  for (const sgm of model.segs) {
    const [x0, y0, z0, x1, y1, z1, r0, r1, seg] = sgm;
    tmpA.set(x0, y0, z0); tmpB.set(x1, y1, z1);
    tmpD.subVectors(tmpB, tmpA).normalize();
    tmpT.set(0, 1, 0); if (Math.abs(tmpD.y) > 0.9) tmpT.set(1, 0, 0);
    tmpU.crossVectors(tmpD, tmpT).normalize(); tmpV.crossVectors(tmpD, tmpU);
    const base = pos.length / 3;
    for (let k = 0; k <= seg; k++) {
      const ang = k / seg * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      const nx = tmpU.x * cs + tmpV.x * sn, ny = tmpU.y * cs + tmpV.y * sn, nz = tmpU.z * cs + tmpV.z * sn;
      for (let e = 0; e < 2; e++) {
        const r = e ? r1 : r0, px = (e ? x1 : x0) + nx * r, py = (e ? y1 : y0) + ny * r, pz = (e ? z1 : z0) + nz * r;
        pos.push(px, py, pz); nor.push(nx, ny, nz);
        uv.push(bu0 + 0.5 * (0.02 + 0.96 * k / seg), bv0 + (bv1 - bv0) * e);
        const sh = 0.78 + 0.22 * Math.min(1, (e ? y1 : y0) * 3);
        col.push(bark[0] * sh, bark[1] * sh, bark[2] * sh); aT.push(0, 0.9); aC.push(px, py, pz);
      }
    }
    for (let k = 0; k < seg; k++) { const i = base + k * 2; idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  }
  // leaf cards
  const cell = S.cell, cx0 = (cell % 2) * CELL, cy0 = Math.floor(cell / 2) * CELL;
  const inset = 2;
  const u0 = (cx0 + inset) / ATLAS_W, u1 = (cx0 + CELL - inset) / ATLAS_W;
  const v0 = 1 - (cy0 + CELL - inset) / ATLAS_H, v1 = 1 - (cy0 + inset) / ATLAS_H;
  const cornerI = [-1, 1, 1, -1], cornerJ = [-1, -1, 1, 1];
  for (const cd of model.cards) {
    const base = pos.length / 3;
    for (let q = 0; q < 4; q++) {
      const i = cornerI[q], j = cornerJ[q];
      const x = cd.c.x + (cd.ax.x * i + cd.ay.x * j) * cd.s, y = cd.c.y + (cd.ax.y * i + cd.ay.y * j) * cd.s, z = cd.c.z + (cd.ax.z * i + cd.ay.z * j) * cd.s;
      pos.push(x, y, z);
      const n = cd.tipUp ? cd.n : norm3(V(x * 0.6 + cd.n.x * 0.4, (y - S.cy) / (S.ry || 0.4) * 0.5 * 0.6 + cd.n.y * 0.4, z * 0.6 + cd.n.z * 0.4));
      nor.push(n.x, n.y, n.z);
      uv.push(u0 + (i * 0.5 + 0.5) * (u1 - u0), v0 + (j * 0.5 + 0.5) * (v1 - v0));
      col.push(S.leaf[0] * cd.hue[0], S.leaf[1] * cd.hue[1], S.leaf[2] * cd.hue[2]);
      aT.push(1, cd.ao); aC.push(cd.c.x, cd.c.y, cd.c.z);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(aT, 2));
  g.setAttribute('aC', new THREE.Float32BufferAttribute(aC, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2);
  return g;
}

// ------------------------------------------------------------------ impostor bake (2D painter)
function bakeImpostors(model, atlasCv, tierName) {
  const cv = document.createElement('canvas');
  const COLS = VIEWS + 1;
  cv.width = TILE * COLS; cv.height = TILE * SP_COUNT;
  const g = cv.getContext('2d');
  // pre-shaded, species-tinted copies of the leaf cells (4 shade levels)
  const LV = [0.5, 0.68, 0.84, 1.0];
  const variants = [];
  const VS = 128;
  for (let sp = 0; sp < SP_COUNT; sp++) {
    const S = SPECIES[sp], arr = [];
    for (let l = 0; l < LV.length; l++) {
      const c = document.createElement('canvas'); c.width = c.height = VS;
      const x = c.getContext('2d');
      x.drawImage(atlasCv, (S.cell % 2) * CELL, Math.floor(S.cell / 2) * CELL, CELL, CELL, 0, 0, VS, VS);
      x.globalCompositeOperation = 'source-atop';
      const tc = (v) => Math.round(Math.min(1, Math.pow(v, 1 / 2.2)) * 255);
      x.globalAlpha = 0.28; x.fillStyle = `rgb(${tc(S.leaf[0] * 0.55)},${tc(S.leaf[1] * 0.75)},${tc(S.leaf[2] * 0.5)})`; x.fillRect(0, 0, VS, VS);
      x.globalAlpha = 1 - LV[l]; x.fillStyle = '#04100a'; x.fillRect(0, 0, VS, VS);
      arr.push(c);
    }
    variants.push(arr);
  }
  const sx = TILE / (2.3 * BAKE_R0);
  const items = [];
  for (let sp = 0; sp < SP_COUNT; sp++) {
    const m = model[sp];
    const S = SPECIES[sp];
    for (let v = 0; v <= VIEWS; v++) {
      const top = v === VIEWS;
      const phi = v / VIEWS * Math.PI * 2, E = top ? Math.PI / 2 : BAKE_ELEV;
      const cvx = Math.sin(phi) * Math.cos(E), cvy = Math.sin(E), cvz = Math.cos(phi) * Math.cos(E);
      let rx, ry, rz, ux, uy, uz;
      if (top) { rx = 1; ry = 0; rz = 0; ux = 0; uy = 0; uz = -1; }
      else {
        const l = Math.hypot(cvz, cvx); rx = cvz / l; ry = 0; rz = -cvx / l;
        ux = cvy * rz - cvz * ry; uy = cvz * rx - cvx * rz; uz = cvx * ry - cvy * rx; // up = c x right
      }
      const ox = v * TILE, oy = sp * TILE;
      g.save(); g.beginPath(); g.rect(ox, oy, TILE, TILE); g.clip();
      items.length = 0;
      const proj = (x, y, z) => {
        const wx = x * BAKE_R0, wz = z * BAKE_R0;
        const sxp = wx * rx + y * ry + wz * rz, syp = wx * ux + y * uy + wz * uz;
        const d = wx * cvx + y * cvy + wz * cvz;
        return [ox + TILE / 2 + sxp * sx, top ? oy + TILE / 2 - syp * sx : oy + TILE * (1 - syp / 1.05), d];
      };
      for (const s of m.segs) {
        const a = proj(s[0], s[1], s[2]), b = proj(s[3], s[4], s[5]);
        items.push({ d: (a[2] + b[2]) / 2, seg: s, a, b });
      }
      for (const c of m.cards) {
        const p = proj(c.c.x, c.c.y, c.c.z);
        items.push({ d: p[2], card: c, p });
      }
      items.sort((p, q) => p.d - q.d);
      for (const it of items) {
        if (it.seg) {
          const [a, b, s] = [it.a, it.b, it.seg];
          const wl = [s[6] * BAKE_R0 * sx * 2, s[7] * BAKE_R0 * sx * 2];
          const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
          if (L < 0.01 && top) continue;
          const nx = L > 0.01 ? -dy / L : 1, ny = L > 0.01 ? dx / L : 0;
          const bk = S.bark;
          const tcv = (q) => Math.round(Math.min(1, Math.pow(q * 0.9, 1 / 2.2)) * 255);
          g.fillStyle = `rgb(${tcv(bk[0])},${tcv(bk[1])},${tcv(bk[2])})`;
          g.beginPath();
          g.moveTo(a[0] + nx * wl[0] / 2, a[1] + ny * wl[0] / 2); g.lineTo(b[0] + nx * wl[1] / 2, b[1] + ny * wl[1] / 2);
          g.lineTo(b[0] - nx * wl[1] / 2, b[1] - ny * wl[1] / 2); g.lineTo(a[0] - nx * wl[0] / 2, a[1] - ny * wl[0] / 2); g.fill();
        } else {
          const c = it.card, p = it.p;
          const sh = Math.min(1, 0.55 * c.ao + 0.5);
          let lvl = 0; for (let l = 0; l < LV.length; l++) if (sh >= LV[l] - 0.08) lvl = l;
          const sA = c.s * BAKE_R0;
          const sxv = [(c.ax.x * rx + c.ax.z * rz) * sA * sx, (c.ax.x * ux + c.ax.y * uy + c.ax.z * uz) * sA * (top ? sx : TILE / 1.05) * (top ? -1 : -1)];
          const syv = [(c.ay.x * rx + c.ay.z * rz) * sA * sx, (c.ay.x * ux + c.ay.y * uy + c.ay.z * uz) * sA * (top ? sx : TILE / 1.05) * (top ? -1 : -1)];
          // note: ux,uy,uz dot uses full vector (x,y,z are unit space scaled by BAKE_R0 for x/z handled below)
          const axw = [c.ax.x * BAKE_R0, c.ax.y / BAKE_R0, c.ax.z * BAKE_R0];
          const ayw = [c.ay.x * BAKE_R0, c.ay.y / BAKE_R0, c.ay.z * BAKE_R0];
          // card half-extent in world units is s*R0 along each axis (isotropic); recompute properly
          const hx = [c.ax.x, c.ax.y, c.ax.z], hy = [c.ay.x, c.ay.y, c.ay.z];
          const pr = (v) => [(v[0] * rx + v[2] * rz) * sA * sx, (top ? -1 : -1) * (v[0] * ux + v[1] * uy + v[2] * uz) * sA * (top ? sx : TILE / 1.05)];
          const Sx = pr(hx), Sy = pr(hy);
          void sxv; void syv; void axw; void ayw;
          const k = 2 / VS;
          g.setTransform(Sx[0] * k, Sx[1] * k, -Sy[0] * k, -Sy[1] * k, p[0] - Sx[0] + Sy[0], p[1] - Sx[1] + Sy[1]);
          g.drawImage(variants[c.sp !== undefined ? c.sp : m.sp][lvl], 0, 0);
          g.setTransform(1, 0, 0, 1, 0, 0);
        }
      }
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 2;
  return t;
}

// ------------------------------------------------------------------ shader snippets
const DITHER = 'float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }';

const WIND_VERT = /* glsl */`
  float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
  vec3 off = position - aC;
  transformed = aC + off * vec3(1.0, sx / sy, 1.0);
  vec3 ip = instanceMatrix[3].xyz;
  float ph = ip.x * 0.13 + ip.z * 0.17;
  {
    float hh = clamp(position.y, 0.0, 1.2);
    float sway = sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25 + 0.35;
    vec3 dW = vec3(uWind.x, 0.0, uWind.y) * sway * 0.014 * sy * hh * hh;
    vec3 ex = instanceMatrix[0].xyz / sx, ez = instanceMatrix[2].xyz / sx;
    transformed.x += dot(dW, ex) / sx; transformed.z += dot(dW, ez) / sx;
    float phc = dot(aC, vec3(7.1, 5.3, 6.7)) + ph;
    float amp = 0.010 * (0.5 + length(uWind)) * aT.x;
    transformed += vec3(sin(uTime * 4.7 + phc), sin(uTime * 6.1 + phc * 1.3) * 0.5 * sx / sy, cos(uTime * 5.3 + phc * 0.7)) * amp;
  }
`;

// ------------------------------------------------------------------ main
export function createTrees(features, hf, opts) {
  const trees = features.trees;
  const N = trees.length;
  const tx = new Float32Array(N), ty = new Float32Array(N), tz = new Float32Array(N), th = new Float32Array(N), tr = new Float32Array(N);
  const tsp = new Uint8Array(N);
  const ttint = new Float32Array(N * 3);
  const noise2 = (x, z, s) => {
    const gx = Math.floor(x / s), gz = Math.floor(z / s);
    let fx = x / s - gx, fz = z / s - gz; fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
    const a = hash2(gx, gz), b = hash2(gx + 1, gz), c = hash2(gx, gz + 1), d = hash2(gx + 1, gz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
  for (let i = 0; i < N; i++) {
    const [x, y, z, h, r] = trees[i];
    tx[i] = x; ty[i] = y; tz[i] = z; th[i] = Math.max(2.5, h); tr[i] = Math.max(0.8, Math.min(r, h * 0.7));
    const hs = hash2(x, z), hu = hash2(z * 1.9 + 3, x * 0.7);
    const patch = noise2(x, z, 150);
    const conBias = patch > 0.64 ? 0.55 : patch > 0.54 ? 0.22 : 0.05;
    const narrow = tr[i] < th[i] * 0.22;
    let sp;
    if (hs < conBias || (narrow && hash2(x * 0.3, z * 0.9) < 0.6)) sp = 5;
    else {
      const small = th[i] < 8;
      const u = hu;
      if (small && u < 0.35) sp = 3;
      else if (u < 0.28) sp = 0;
      else if (u < 0.50) sp = 1;
      else if (u < 0.70) sp = 2;
      else if (u < 0.82) sp = 3;
      else sp = 4;
    }
    tsp[i] = sp;
    // tint (multiplies leaf colour): healthy greens, a few trees touched by early autumn
    const a = hash2(x * 0.37, z * 0.71), b = hash2(x * 1.3 + 9, z * 0.2), c = hash2(z * 0.9, x * 1.1 + 5);
    let r0 = 0.96 + 0.10 * b, g0 = 1.0 + 0.06 * c, b0 = 0.92 + 0.12 * a;
    if (sp !== 5) {
      const au = sp === 3 ? 0.80 : 0.90;
      if (a > au) { const k = 0.35 + 0.35 * b; r0 += (1.5 - r0) * k; g0 += (1.02 - g0) * k; b0 += (0.55 - b0) * k; }
      else if (a > au - 0.12) { const k = 0.25; r0 += (1.2 - r0) * k; g0 += (1.04 - g0) * k; b0 += (0.78 - b0) * k; }
    }
    ttint[i * 3] = r0; ttint[i * 3 + 1] = g0; ttint[i * 3 + 2] = b0;
  }
  // spatial grid
  const CELLW = 64;
  const gx = Math.ceil(hf.width / CELLW) + 1, gz = Math.ceil(hf.depth / CELLW) + 1;
  const cellStart = new Int32Array(gx * gz + 1);
  const cellOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const cx = Math.min(gx - 1, Math.max(0, Math.floor((tx[i] - hf.x0) / CELLW)));
    const cz = Math.min(gz - 1, Math.max(0, Math.floor((tz[i] - hf.z0) / CELLW)));
    cellOf[i] = cz * gx + cx; cellStart[cellOf[i] + 1]++;
  }
  for (let c = 0; c < gx * gz; c++) cellStart[c + 1] += cellStart[c];
  const order = new Int32Array(N); const fill = cellStart.slice(0, gx * gz);
  for (let i = 0; i < N; i++) order[fill[cellOf[i]]++] = i;

  const { tex: leafTex, cv: atlasCv } = makeAtlas();
  const group = new THREE.Group(); group.name = 'trees';

  const models0 = [], models1 = [];
  for (let s = 0; s < SP_COUNT; s++) { models0.push(buildModel(s, 0, opts.tier)); models1.push(buildModel(s, 1, opts.tier)); }
  const geo0 = models0.map(modelGeometry), geo1 = models1.map(modelGeometry);
  const impTex = bakeImpostors(models0, atlasCv, opts.tier);

  const fadeBand = 30;
  const uNear = { value: opts.nearRadius };
  const uD0 = { value: Math.max(40, opts.nearRadius * 0.5) };

  function makeMat(lod) {
    const mat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 1.0, metalness: 0, envMapIntensity: 0.5, color: 0xffffff, vertexColors: true });
    patchMaterial(mat, {
      key: 'treesL' + lod, uniforms: { uNear, uD0 },
      vertexPars: `attribute vec2 aT; attribute vec3 aC; attribute vec3 aTint; varying vec2 vT; varying vec3 vTint; varying float vIDist; uniform float uTime; uniform float uNear; uniform vec2 uWind;`,
      vertex: {
        begin_vertex: `$
          vT = aT; vTint = aTint;
          ${WIND_VERT}
          vIDist = distance(ip, cameraPosition);`,
      },
      fragmentPars: `${GRID_GLSL} ${OCC_GLSL} varying vec2 vT; varying vec3 vTint; varying float vIDist; uniform float uNear; uniform float uD0; float hbSun;`,
      fragment: {
        map_fragment: `$
          {
            float fFar = smoothstep(uNear - ${fadeBand.toFixed(1)}, uNear, vIDist);
            float f0 = smoothstep(uD0 - 6.0, uD0 + 6.0, vIDist);
            float dn = ign(gl_FragCoord.xy);
            ${lod === 0 ? 'if (dn < f0) discard;' : 'if (dn >= f0 || dn < fFar) discard;'}
            if (dn > occFade(vAerialWorld)) discard;
          }
          diffuseColor.rgb *= mix(vec3(1.0), vTint, vT.x);`,
        lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;'),
        // double-sided leaf cards keep their (spherical) normal on both faces for soft crown shading
        normal_fragment_begin: `
          float faceDirection = 1.0;
          vec3 normal = normalize(vNormal);
          vec3 nonPerturbedNormal = normal;
          hbSun = texture2D(uShadowBake, gridUV(vAerialWorld.xz)).r;`,
        aomap_fragment: `float tao = mix(1.0, vT.y, 0.8);
          reflectedLight.indirectDiffuse *= tao; reflectedLight.directDiffuse *= mix(1.0, vT.y, 0.55); reflectedLight.indirectSpecular *= tao;
          {
            vec3 vd = normalize(vAerialWorld - cameraPosition);
            float back = pow(max(dot(vd, uSunDir), 0.0), 4.0) * vT.x * hbSun;
            // backlit translucency: yellow-green glow, stronger on thin outer leaves
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3(1.15, 1.2, 0.55) * uSunColor * back * (0.35 + 0.65 * vT.y) * 1.1;
            // soft wrap light so the shaded side stays lush rather than muddy
            float wrap = clamp(dot(normal, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
            reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * wrap * wrap * 0.10 * hbSun * vT.x * vT.y;
          }`,
      },
    });
    return mat;
  }
  const mat0 = makeMat(0), mat1 = makeMat(1);

  // shadow caster: same card isotropy / sway as the visible material
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide });
  depthMat.customProgramCacheKey = () => 'hb-treesDepth';
  depthMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uTime: U.uTime, uWind: U.uWind });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aT; attribute vec3 aC; uniform float uTime; uniform vec2 uWind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERT);
  };

  const MAXN = opts.maxNear;
  const mkMesh = (geo, mat) => {
    const m = new THREE.InstancedMesh(geo, mat, MAXN);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ta = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 3), 3);
    ta.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTint', ta);
    m.userData.tint = ta;
    m.count = 0; m.frustumCulled = false;
    m.castShadow = true; m.receiveShadow = true;
    m.customDepthMaterial = depthMat;
    group.add(m);
    return m;
  };
  const meshes0 = geo0.map((g) => mkMesh(g, mat0));
  const meshes1 = geo1.map((g) => mkMesh(g, mat1));

  // --- far impostors (all trees)
  const farGeo = new THREE.InstancedBufferGeometry();
  farGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  farGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const a1 = new Float32Array(N * 4), a2 = new Float32Array(N * 4), a3 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    a1[i * 4] = tx[i]; a1[i * 4 + 1] = ty[i] - 0.3; a1[i * 4 + 2] = tz[i]; a1[i * 4 + 3] = th[i];
    a2[i * 4] = tr[i]; a2[i * 4 + 1] = tsp[i]; a2[i * 4 + 2] = hash2(tx[i] * 0.9, tz[i] * 1.7); a2[i * 4 + 3] = 0;
    a3[i * 3] = ttint[i * 3]; a3[i * 3 + 1] = ttint[i * 3 + 1]; a3[i * 3 + 2] = ttint[i * 3 + 2];
  }
  farGeo.setAttribute('aA', new THREE.InstancedBufferAttribute(a1, 4));
  farGeo.setAttribute('aB', new THREE.InstancedBufferAttribute(a2, 4));
  farGeo.setAttribute('aD', new THREE.InstancedBufferAttribute(a3, 3));
  farGeo.instanceCount = N;
  farGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const farMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uImp: { value: impTex }, uNear },
    vertexShader: /* glsl */`
      #include <common>
      attribute vec4 aA; attribute vec4 aB; attribute vec3 aD;
      uniform float uNear; uniform vec3 uSunDir; uniform float uTime; uniform vec2 uWind;
      ${GRID_GLSL}
      varying vec2 vUv; varying vec3 vWorld; varying vec3 vTint; varying float vFade; varying vec3 vRight; varying vec3 vUp; varying vec3 vFwd; varying float vSun; varying float vSp; varying float vAz; varying float vElev;
      void main() {
        vec3 base = aA.xyz; float h = aA.w; float r = aB.x;
        vec3 cc = base + vec3(0.0, h * 0.55, 0.0);
        vec3 dir = normalize(cameraPosition - cc);
        float elevF = smoothstep(0.5, 0.95, dir.y);
        vec3 hd = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-4, 0.0, 1e-4));
        vec3 right = vec3(hd.z, 0.0, -hd.x);
        vec3 up3 = normalize(cross(dir, right));
        vec3 upq = normalize(mix(vec3(0.0, 1.0, 0.0), up3, elevF));
        float w = r * 1.15;
        float H = mix(h * 1.05, 2.3 * r, elevF);
        vec3 ctr = mix(base + vec3(0.0, H * 0.5, 0.0), cc, elevF);
        // light sway so far trees are not frozen
        float ph = base.x * 0.13 + base.z * 0.17;
        vec3 p = ctr + right * position.x * w + upq * (position.y - 0.5) * H;
        p.xz += uWind * (sin(uTime * 1.1 + ph) * 0.6 + 0.35) * 0.012 * h * position.y * position.y;
        vUv = vec2(position.x * 0.5 + 0.5, position.y);
        vRight = right; vUp = upq; vFwd = dir;
        vWorld = p; vTint = aD;
        vFade = smoothstep(uNear - 30.0, uNear, distance(base, cameraPosition));
        vSp = aB.y; vAz = atan(dir.x, dir.z); vElev = elevF;
        vSun = texture2D(uShadowBake, gridUV(base.xz)).r;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        if (vFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D uImp; uniform float uSunI; uniform vec3 uSkyAmb;
      ${AERIAL_GLSL}
      ${DITHER}
      varying vec2 vUv; varying vec3 vWorld; varying vec3 vTint; varying float vFade; varying vec3 vRight; varying vec3 vUp; varying vec3 vFwd; varying float vSun; varying float vSp; varying float vAz; varying float vElev;
      void main() {
        float dn = ign(gl_FragCoord.xy);
        if (dn > vFade) discard;
        float nz = fract(dn * 7.37 + 0.31);
        // pick one of the 8 baked side views (stochastic blend of the two nearest) or the top view
        float f = vAz / 6.2831853 * ${VIEWS.toFixed(1)}; f = f - floor(f / ${VIEWS.toFixed(1)}) * ${VIEWS.toFixed(1)};
        float i0 = floor(f), fr = f - i0;
        float view = mod(i0 + (nz < fr ? 1.0 : 0.0), ${VIEWS.toFixed(1)});
        bool top = fract(nz * 3.77 + 0.5) < vElev;
        if (top) view = ${VIEWS.toFixed(1)};
        vec2 uv = vec2((view + clamp(vUv.x, 0.006, 0.994)) / ${(VIEWS + 1).toFixed(1)}, 1.0 - (vSp + 1.0 - clamp(vUv.y, 0.003, 0.997)) / ${SP_COUNT.toFixed(1)});
        vec4 t = texture2D(uImp, uv);
        if (t.a < 0.42) discard;
        vec3 alb = t.rgb * mix(vec3(1.0), vTint, step(0.0, vSp - 4.5) < 0.5 ? 1.0 : 0.0);
        vec2 q = vec2(vUv.x * 2.0 - 1.0, (vUv.y - 0.5) * 2.0);
        float z = sqrt(max(0.0, 1.0 - dot(q, q) * 0.7));
        vec3 n = normalize(vRight * q.x * 0.9 + vUp * q.y * 0.7 + vFwd * z);
        n = normalize(n + vec3(0.0, 0.15, 0.0));
        float ndl = max(dot(n, uSunDir), 0.0);
        vec3 vd = normalize(vWorld - cameraPosition);
        float back = pow(max(dot(vd, uSunDir), 0.0), 4.0) * 0.6;
        float wrap = clamp(dot(n, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = alb * (uSunColor * uSunI * (ndl * 0.8 + wrap * wrap * 0.2 + back) * vSun * 0.3183 * 0.95 + uSkyAmb * 0.62 * (0.4 + 0.6 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0)));
        col = applyAerial(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const far = new THREE.Mesh(farGeo, farMat);
  far.frustumCulled = false;
  group.add(far);

  // --- near set maintenance (no allocations)
  const last = new THREE.Vector3(1e9, 0, 0);
  const cnt0 = new Int32Array(SP_COUNT), cnt1 = new Int32Array(SP_COUNT);
  function put(m, n, i) {
    const e = m.instanceMatrix.array, o = n * 16;
    const ang = hash2(tx[i], tz[i] * 3.1) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
    const r = tr[i], h = th[i];
    e[o] = r * cs; e[o + 1] = 0; e[o + 2] = -r * sn; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = h; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = r * sn; e[o + 9] = 0; e[o + 10] = r * cs; e[o + 11] = 0;
    e[o + 12] = tx[i]; e[o + 13] = ty[i] - 0.3; e[o + 14] = tz[i]; e[o + 15] = 1;
    const ta = m.userData.tint.array;
    ta[n * 3] = ttint[i * 3]; ta[n * 3 + 1] = ttint[i * 3 + 1]; ta[n * 3 + 2] = ttint[i * 3 + 2];
  }
  function rebuild(cam) {
    cnt0.fill(0); cnt1.fill(0);
    const R = uNear.value + 5, R2 = R * R;
    const d0 = uD0.value, in0 = (d0 + 12) * (d0 + 12), in1 = Math.max(0, d0 - 12) * Math.max(0, d0 - 12);
    const cx0 = Math.max(0, Math.floor((cam.x - R - hf.x0) / CELLW)), cx1 = Math.min(gx - 1, Math.floor((cam.x + R - hf.x0) / CELLW));
    const cz0 = Math.max(0, Math.floor((cam.z - R - hf.z0) / CELLW)), cz1 = Math.min(gz - 1, Math.floor((cam.z + R - hf.z0) / CELLW));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cz * gx + cx;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const i = order[k];
        const dx = tx[i] - cam.x, dz = tz[i] - cam.z, d2 = dx * dx + dz * dz;
        if (d2 > R2) continue;
        const sp = tsp[i];
        if (d2 < in0 && cnt0[sp] < MAXN) put(meshes0[sp], cnt0[sp]++, i);
        if (d2 >= in1 && cnt1[sp] < MAXN) put(meshes1[sp], cnt1[sp]++, i);
      }
    }
    for (let v = 0; v < SP_COUNT; v++) {
      for (let l = 0; l < 2; l++) {
        const m = l ? meshes1[v] : meshes0[v], n = l ? cnt1[v] : cnt0[v];
        m.count = n; m.visible = n > 0;
        m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, n * 16); m.instanceMatrix.needsUpdate = true;
        const ta = m.userData.tint;
        ta.clearUpdateRanges(); ta.addUpdateRange(0, n * 3); ta.needsUpdate = true;
      }
    }
  }
  return {
    group, count: N, farMaterial: farMat,
    setNearRadius(r) { uNear.value = r; uD0.value = Math.max(40, r * 0.5); last.set(1e9, 0, 0); },
    update(cam) {
      const dx = cam.x - last.x, dz = cam.z - last.z;
      if (dx * dx + dz * dz > 36) { rebuild(cam); last.copy(cam); }
    },
  };
}
