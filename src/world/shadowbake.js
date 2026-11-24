import * as THREE from 'three';
import { pointInPoly } from './heightfield.js';

// Bakes long-range sun shadows on the 4 m grid:
//  R = terrain self-shadow (hills), G = shadow from buildings + tree canopy.
// The realtime cascades cover the near field; this covers the distance.
export async function bakeShadows(hf, features, sunDir, slicer, onProgress) {
  const { cols, rows, res } = hf;
  const n = cols * rows;
  const H = hf.h;
  const O = new Float32Array(H); // object surface (DSM)
  for (const b of features.buildings) {
    const top = b.b + (b.e + b.h) * 0.5;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
    const i0 = Math.max(0, Math.ceil((x0 - hf.x0) / res)), i1 = Math.min(cols - 1, Math.floor((x1 - hf.x0) / res));
    const j0 = Math.max(0, Math.ceil((z0 - hf.z0) / res)), j1 = Math.min(rows - 1, Math.floor((z1 - hf.z0) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      if (pointInPoly(hf.x0 + i * res, hf.z0 + j * res, b.p)) { const k = j * cols + i; if (top > O[k]) O[k] = top; }
    }
  }
  await slicer.tick();
  for (const t of features.trees) {
    const [x, y, z, h, r] = t;
    const ci = (x - hf.x0) / res, cj = (z - hf.z0) / res, rr = r / res;
    for (let j = Math.max(0, Math.floor(cj - rr)); j <= Math.min(rows - 1, Math.ceil(cj + rr)); j++)
      for (let i = Math.max(0, Math.floor(ci - rr)); i <= Math.min(cols - 1, Math.ceil(ci + rr)); i++) {
        const d2 = ((i - ci) ** 2 + (j - cj) ** 2) / (rr * rr + 1e-6);
        if (d2 > 1) continue;
        const top = y + h * (0.55 + 0.45 * Math.sqrt(1 - d2));
        const k = j * cols + i; if (top > O[k]) O[k] = top;
      }
  }
  await slicer.tick();

  const hx = sunDir.x, hz = sunDir.z, hl = Math.hypot(hx, hz);
  const dx = hx / hl, dz = hz / hl, tanEl = sunDir.y / hl;
  const STEPS = 110;
  const offI = new Int32Array(STEPS), offJ = new Int32Array(STEPS), dist = new Float32Array(STEPS);
  let s = 0;
  for (let k = 0; k < STEPS; k++) {
    s += k < 40 ? res : k < 80 ? res * 2 : res * 4;
    dist[k] = s; offI[k] = Math.round(s * dx / res); offJ[k] = Math.round(s * dz / res);
  }
  const maxH = hf.maxH + 35;
  const out = new Uint8Array(n * 4);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k0 = j * cols + i;
      const h0 = H[k0] + 0.3;
      let sT = 1, sO = 1;
      for (let k = 0; k < STEPS; k++) {
        const ry = h0 + dist[k] * tanEl;
        if (ry > maxH) break;
        const ii = i + offI[k], jj = j + offJ[k];
        if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) break;
        const kk = jj * cols + ii;
        const soft = 0.6 + dist[k] * 0.035;
        const t = 0.5 + (ry - H[kk]) / soft;
        if (t < sT) sT = t < 0 ? 0 : t;
        if (k < 45) {
          const o = 0.5 + (ry - O[kk]) / soft;
          if (o < sO) sO = o < 0 ? 0 : o;
        }
        if (sT <= 0) break;
      }
      const q = k0 * 4;
      out[q] = Math.min(1, sT) * 255; out[q + 1] = Math.min(1, sO) * 255; out[q + 2] = 0; out[q + 3] = 255;
    }
    if ((j & 15) === 0) { await slicer.tick(); onProgress && onProgress(j / rows); }
  }
  const tex = new THREE.DataTexture(out, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return { texture: tex, dsm: O };
}
