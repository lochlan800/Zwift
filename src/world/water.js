import * as THREE from 'three';
import { U, AERIAL_GLSL, GRID_GLSL } from './shared.js';

// Rivers, canal, ponds: flat polygons + ribbons for line-only waterways.
export function createWater(features, hf) {
  const pos = [], uvA = [], idx = [];
  let n = 0;
  for (const w of features.water) {
    if (!w.p || !w.p.length || w.p[0].length < 3) continue;
    const y = w.y ?? hf.sample(w.p[0][0][0], w.p[0][0][1]);
    const contour = w.p[0].map((q) => new THREE.Vector2(q[0], q[1]));
    const holes = w.p.slice(1).filter((h) => h.length >= 3).map((h) => h.map((q) => new THREE.Vector2(q[0], q[1])));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, holes); } catch (e) { continue; }
    const all = contour.concat(...holes);
    const flow = w.k === 'river' ? 1 : w.k === 'canal' ? 0.25 : 0.05;
    for (const p of all) { pos.push(p.x, y, p.y); uvA.push(flow, 0); }
    for (const t of tris) {
      const a = all[t[0]], b = all[t[1]], c = all[t[2]];
      const ny = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y);
      if (ny > 0) idx.push(n + t[0], n + t[1], n + t[2]); else idx.push(n + t[0], n + t[2], n + t[1]);
    }
    n += all.length;
  }
  for (const w of features.waterways) {
    if (!w.p || w.p.length < 2) continue;
    const hw = Math.max(0.6, (w.w || (w.k === 'river' ? 8 : w.k === 'canal' ? 6 : 1.5)) / 2);
    const p = w.p;
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const y = p[i][1] + 0.02;
      pos.push(p[i][0] + dz * hw, y, p[i][2] - dx * hw, p[i][0] - dz * hw, y, p[i][2] + dx * hw);
      uvA.push(0.6, 1, 0.6, -1);
      if (i > 0) { const k = n + i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
    }
    n += p.length * 2;
  }
  if (!n) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aF', new THREE.Float32BufferAttribute(uvA, 2));
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uDeep: { value: new THREE.Color().setRGB(0.012, 0.022, 0.02) }, uShallow: { value: new THREE.Color().setRGB(0.05, 0.06, 0.035) } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      attribute vec2 aF; varying vec2 vF; varying vec3 vWorld;
      void main() { vF = aF; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D uNoise; uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow;
      ${AERIAL_GLSL}
      ${GRID_GLSL}
      varying vec2 vF; varying vec3 vWorld;
      vec2 nrm(vec2 p) {
        float e = 0.02;
        float h0 = texture2D(uNoise, p).b, hx = texture2D(uNoise, p + vec2(e, 0.0)).b, hz = texture2D(uNoise, p + vec2(0.0, e)).b;
        return vec2(h0 - hx, h0 - hz);
      }
      void main() {
        vec3 vdir = vWorld - cameraPosition; float dist = length(vdir); vdir /= dist;
        float t = uTime;
        vec2 p = vWorld.xz;
        vec2 flow = vec2(0.7, 0.3) * vF.x;
        vec2 g = nrm(p / 9.0 + flow * t * 0.02 + vec2(t * 0.004, 0.0)) * 1.0 + nrm(p / 3.3 - flow * t * 0.03 + vec2(0.0, t * 0.011)) * 0.6
               + nrm(p / 1.1 + vec2(t * 0.02, -t * 0.015)) * 0.3;
        float fade = 1.0 - smoothstep(30.0, 400.0, dist);
        vec3 N = normalize(vec3(g.x * 3.0 * fade, 1.0, g.y * 3.0 * fade));
        vec3 R = reflect(vdir, N);
        R.y = abs(R.y);
        float cosT = max(dot(-vdir, N), 0.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        vec3 refl = skyLUT(R) * 0.95;
        // banks/vegetation reflection: darken low-elevation reflections
        refl *= mix(0.35, 1.0, smoothstep(0.02, 0.25, R.y));
        vec3 H = normalize(uSunDir - vdir);
        float spec = pow(max(dot(N, H), 0.0), 600.0) * 60.0 + pow(max(dot(N, H), 0.0), 60.0) * 0.6;
        float sh = texture2D(uShadowBake, gridUV(vWorld.xz)).r * texture2D(uShadowBake, gridUV(vWorld.xz)).g;
        vec3 body = mix(uShallow, uDeep, 0.6) * (0.6 + 0.4 * sh);
        vec3 col = mix(body, refl, F) + uSunColor * spec * sh;
        col = applyAerial(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -1;
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'water';
  return { mesh };
}

// Lower terrain under water so the (flat) water surface never z-fights the LiDAR water returns.
import { pointInPoly } from './heightfield.js';
export function carveWater(hf, features) {
  const { cols, rows, res } = hf;
  for (const w of features.water) {
    if (!w.p || !w.p.length || w.p[0].length < 3) continue;
    const outer = w.p[0];
    const y = w.y ?? hf.sample(outer[0][0], outer[0][1]);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of outer) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[1]); z1 = Math.max(z1, q[1]); }
    const i0 = Math.max(0, Math.floor((x0 - hf.x0) / res)), i1 = Math.min(cols - 1, Math.ceil((x1 - hf.x0) / res));
    const j0 = Math.max(0, Math.floor((z0 - hf.z0) / res)), j1 = Math.min(rows - 1, Math.ceil((z1 - hf.z0) / res));
    const depth = w.k === 'river' ? 1.6 : w.k === 'canal' ? 1.4 : 0.8;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = hf.x0 + i * res, z = hf.z0 + j * res;
      if (!pointInPoly(x, z, outer)) continue;
      let inHole = false;
      for (let hI = 1; hI < w.p.length; hI++) if (w.p[hI].length >= 3 && pointInPoly(x, z, w.p[hI])) { inHole = true; break; }
      if (inHole) continue;
      const k = j * cols + i;
      hf.h[k] = Math.min(hf.h[k], y - depth);
    }
  }
  for (const w of features.waterways) {
    if (!w.p || w.p.length < 2) continue;
    const hw = Math.max(0.6, (w.w || 1.5) / 2);
    for (let s = 0; s + 1 < w.p.length; s++) {
      const a = w.p[s], b = w.p[s + 1];
      const R = hw + 1;
      const ia = Math.max(0, Math.floor((Math.min(a[0], b[0]) - R - hf.x0) / res)), ib = Math.min(cols - 1, Math.ceil((Math.max(a[0], b[0]) + R - hf.x0) / res));
      const ja = Math.max(0, Math.floor((Math.min(a[2], b[2]) - R - hf.z0) / res)), jb = Math.min(rows - 1, Math.ceil((Math.max(a[2], b[2]) + R - hf.z0) / res));
      const dx = b[0] - a[0], dz = b[2] - a[2], L2 = dx * dx + dz * dz || 1;
      for (let j = ja; j <= jb; j++) for (let i = ia; i <= ib; i++) {
        const x = hf.x0 + i * res, z = hf.z0 + j * res;
        let t = ((x - a[0]) * dx + (z - a[2]) * dz) / L2; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(a[0] + dx * t - x, a[2] + dz * t - z);
        if (d > R) continue;
        const y = a[1] + (b[1] - a[1]) * t;
        const k = j * cols + i;
        hf.h[k] = Math.min(hf.h[k], y - (d < hw ? 0.6 : 0.25));
      }
    }
  }
}
