import * as THREE from 'three';
import { U, AERIAL_GLSL, GRID_GLSL } from './shared.js';
import { hash2, mulberry32 } from './heightfield.js';

// Instanced grass clumps in a toroidal ring of cells around the camera.
// Two looks (decided per clump when the cell is filled, packed into aI.w):
//   type 0  neat lawn / park / verge in town: short, saturated yellow-green, mown-stripe hints, a few daisies
//   type 1  rough grass (scrub, woodland edge, rural road verges): knee-high tufts, green mixed with
//           straw/golden blades, seed heads and wildflower specks
// Clumps shrink and thin out towards the edge of the ring so there is no visible boundary.
const CELL = 6;
// landcover class -> [probability, type, height (m), flower chance]
const CLS = {
  0: [0.9, 0, 0.18, 0.04],   // grass / pasture
  6: [1.0, 0, 0.13, 0.03],   // park / pitch
  9: [1.0, 0, 0.15, 0.03],   // cemetery
  3: [0.85, 0, 0.14, 0.03],  // residential ground (lawns, verges)
  8: [0.7, 0, 0.18, 0.03],   // allotments / gardens
  7: [1.0, 1, 0.62, 0.35],   // scrub / rough
  2: [0.35, 1, 0.55, 0.20],  // woodland understorey
  1: [0.0, 0, 0.0, 0.0],     // farmland: bare/stubble, none
};
const VERGE_BAND = 3.6;      // metres of rough grass beyond a rural road edge

function clumpGeometry(nb, nt, ns) {
  const pos = [], uv = [], kd = [], idx = [];
  const rnd = mulberry32(2024);
  let v = 0;
  const blade = (kind, rootR, a, h, lean, w, br, curl) => {
    const bx = Math.cos(a) * rootR, bz = Math.sin(a) * rootR;
    const fa = a + 1.57 + (rnd() - 0.5) * 1.2;
    const fx = Math.cos(fa), fz = Math.sin(fa);
    const rows = 3;
    const base = v;
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const ww = w * (1 - t * t * 0.92) * (r === rows - 1 ? 0.0 : 1.0);
      const off = lean * t * t * h;
      const ox = bx + Math.cos(a) * off + fx * curl * t * t * h, oz = bz + Math.sin(a) * off + fz * curl * t * t * h;
      const oy = t * h * (1 - 0.1 * lean);
      if (r === rows - 1) { pos.push(ox, oy, oz); uv.push(0.5, 1); kd.push(kind, br); v += 1; }
      else {
        pos.push(ox - fx * ww, oy, oz - fz * ww, ox + fx * ww, oy, oz + fz * ww);
        uv.push(0, t, 1, t); kd.push(kind, br, kind, br); v += 2;
      }
    }
    // rows: [0,1] [2,3] tip 4
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
    return [bx + Math.cos(a) * lean * h, h, bz + Math.sin(a) * lean * h, fx, fz];
  };
  const head = (kind, x, y, z, a, len, wd, br) => {
    // two crossed tapered quads (ear / seed head)
    for (let q = 0; q < 2; q++) {
      const fa = a + q * 1.5708, fx = Math.cos(fa), fz = Math.sin(fa);
      const b = v;
      pos.push(x - fx * wd, y, z - fz * wd, x + fx * wd, y, z + fz * wd, x + fx * wd * 0.8, y + len * 0.6, z + fz * wd * 0.8, x - fx * wd * 0.8, y + len * 0.6, z - fz * wd * 0.8, x, y + len, z);
      uv.push(0, 1, 1, 1, 1, 1, 0, 1, 0.5, 1); for (let k = 0; k < 5; k++) kd.push(kind, br);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b + 3, b + 2, b + 4);
      v += 5;
    }
  };
  for (let i = 0; i < nb; i++) {
    const a = (i / nb) * Math.PI * 2 + rnd() * 0.8;
    blade(0, 0.04 + Math.sqrt(rnd()) * 0.42, a, 0.6 + rnd() * 0.4, 0.25 + rnd() * 0.45, 0.011 + rnd() * 0.006, rnd(), (rnd() - 0.5) * 0.25);
  }
  for (let i = 0; i < nt; i++) {
    const a = (i / nt) * Math.PI * 2 + rnd() * 1.2;
    blade(1, 0.03 + Math.sqrt(rnd()) * 0.35, a, 1.0 + rnd() * 0.35, 0.12 + rnd() * 0.3, 0.012 + rnd() * 0.005, rnd(), (rnd() - 0.5) * 0.3);
  }
  for (let i = 0; i < ns; i++) {
    const a = (i / Math.max(1, ns)) * Math.PI * 2 + rnd() * 2;
    const t = blade(1, 0.04 + rnd() * 0.08, a, 1.05 + rnd() * 0.25, 0.15 + rnd() * 0.2, 0.005, rnd(), 0.12);
    head(2, t[0], t[1] * 0.98, t[2], rnd() * 6, 0.2, 0.012, rnd());
  }
  // a wildflower: thin stem + small crossed kite head
  {
    const a = rnd() * 6.28;
    const t = blade(3, 0.1, a, 0.8 + rnd() * 0.3, 0.1, 0.006, 0.5, 0.1);
    head(4, t[0], t[1], t[2], rnd() * 6, 0.07, 0.035, rnd());
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aK', new THREE.Float32BufferAttribute(kd, 2));
  g.setIndex(idx);
  return g;
}

export function createGrass(hf, lc, roadIdx, bIdx, cfg) {
  if (cfg.grass <= 0) return null;
  const R = cfg.grassRadius;
  const n = Math.ceil(R / CELL);
  const M = 2 * n + 1;
  const K = Math.round(75 * cfg.grass);
  const total = M * M * K;
  const low = cfg.tier === 'low';
  const geo = clumpGeometry(low ? 11 : 20, low ? 3 : 4, low ? 1 : 2);
  const inst = new Float32Array(total * 4);
  const attr = new THREE.InstancedBufferAttribute(inst, 4);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aI', attr);
  geo.instanceCount = total;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const slotCell = new Int32Array(M * M * 2).fill(-999999);
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  const uR = { value: R };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uR },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      attribute vec4 aI; attribute vec2 aK; uniform float uR; uniform float uTime; uniform vec2 uWind; uniform sampler2D uNoise; uniform vec3 uSunDir;
      ${GRID_GLSL}
      varying vec3 vWorld; varying vec3 vCol; varying float vT; varying float vSun; varying vec3 vN;
      vec3 lin(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
      float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
      void main() {
        float typ = floor(aI.w / 4.0 + 0.001);
        float sc = aI.w - typ * 4.0;
        float kind = aK.x;
        float d = distance(aI.xz, cameraPosition.xz);
        float r1 = h11(aI.x * 0.731 + aI.z * 1.317), r2 = h11(aI.x * 1.913 - aI.z * 0.377), r3 = h11(aI.z * 2.17 + aI.x * 0.59);
        // thin out + shrink with distance
        float keep = 1.0 - 0.7 * smoothstep(uR * 0.4, uR, d);
        float s = sc * (1.0 - smoothstep(uR * 0.62, uR, d)) * step(r2, keep);
        bool rough = typ > 0.5;
        // flower chance is stored in the fractional hash: lawns get few daisies, rough grass many wildflowers
        float flowerP = rough ? 0.42 : 0.05;
        if (kind > 2.5 && r3 > flowerP) s = 0.0;
        if (kind > 0.5 && kind < 2.5 && !rough) s = 0.0;
        float ang = r1 * 6.2831;
        float cs = cos(ang), sn = sin(ang);
        vec3 p = position;
        p.xz = mat2(cs, -sn, sn, cs) * p.xz;
        // blade widths: rough tufts are wider/fuller than the fine lawn
        float wide = rough ? 1.15 : 1.0;
        p.xz *= wide * mix(0.8, 1.0, min(1.0, s * 3.0));
        p.y *= s;
        float hgt = uv.y;
        if (kind > 0.5 && kind < 1.5) hgt = uv.y;
        float ph = aI.x * 0.31 + aI.z * 0.27;
        float wv = sin(uTime * 1.7 + ph) * 0.5 + sin(uTime * 3.1 + ph * 2.3 + aK.y * 4.0) * 0.25 + 0.3;
        float wy = (kind > 1.5) ? 1.0 : hgt * hgt;
        if (!rough) wy *= 0.6;
        p.xz += uWind * wv * (rough ? 0.5 : 0.28) * wy * min(1.0, s * 1.5) * (0.6 + aK.y * 0.6);
        vec3 w = aI.xyz + p;
        vWorld = w; vT = (kind > 1.5) ? 1.0 : uv.y;
        vec4 n1 = texture2D(uNoise, aI.xz / 260.0), n2 = texture2D(uNoise, aI.xz / 41.0), n3 = texture2D(uNoise, aI.xz / 7.3);
        vec3 col;
        if (!rough) {
          vec3 a = mix(lin(0.19, 0.30, 0.065), lin(0.27, 0.38, 0.09), n2.g);
          a = mix(a, lin(0.31, 0.37, 0.10), smoothstep(0.55, 0.9, n1.r) * 0.45);
          // clover / weed patches: darker, bluer green
          float cl = smoothstep(0.60, 0.78, n3.r * 0.6 + n2.b * 0.5);
          a = mix(a, lin(0.10, 0.22, 0.06), cl * 0.7);
          float st = smoothstep(-0.3, 0.3, sin(dot(aI.xz, vec2(0.62, 0.78)) * 0.55));
          a *= 0.93 + 0.12 * st;
          // sun-dried tips on some blades
          float dry = (aK.y > 0.55 ? 0.6 : 0.2) * smoothstep(0.55, 1.0, uv.y) * (0.4 + n1.r);
          a = mix(a, lin(0.46, 0.40, 0.19), clamp(dry, 0.0, 0.7));
          col = a * (0.88 + 0.24 * aK.y) * 0.88;
        } else {
          vec3 gr = mix(lin(0.18, 0.28, 0.06), lin(0.26, 0.36, 0.09), n2.g);
          vec3 straw = mix(lin(0.48, 0.40, 0.16), lin(0.62, 0.52, 0.24), n3.b);
          float gm = smoothstep(0.30, 0.75, n1.r) * 0.55 + (aK.y > 0.62 ? 0.55 : 0.0) + uv.y * uv.y * 0.35;
          col = mix(gr, straw, clamp(gm, 0.0, 1.0)) * (0.9 + 0.2 * aK.y);
        }
        if (kind > 1.5 && kind < 2.5) col = lin(0.66, 0.53, 0.24) * (0.8 + 0.4 * aK.y) * mix(0.8, 1.0, uv.y);
        if (kind > 2.5 && kind < 3.5) col = lin(0.18, 0.28, 0.07);
        if (kind > 3.5) {
          float c = aK.y;
          col = c < 0.45 ? lin(0.95, 0.94, 0.88) : (c < 0.8 ? lin(0.96, 0.78, 0.10) : lin(0.62, 0.30, 0.62));
        }
        vCol = col;
        vSun = texture2D(uShadowBake, gridUV(aI.xz)).r * texture2D(uShadowBake, gridUV(aI.xz)).g;
        vN = normalize(vec3(cs * 0.3, 1.0, sn * 0.3));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        if (s < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform vec3 uSkyAmb; uniform float uSunI;
      ${AERIAL_GLSL}
      varying vec3 vWorld; varying vec3 vCol; varying float vT; varying float vSun; varying vec3 vN;
      void main() {
        // dark soil-shadowed base to bright sunlit tip: reads as a dense even carpet
        vec3 alb = vCol * mix(0.55, 1.22, smoothstep(0.0, 0.85, vT));
        vec3 vd = normalize(vWorld - cameraPosition);
        float ndl = max(dot(vN, uSunDir), 0.0) * 0.7 + 0.3;
        float tr = pow(max(dot(vd, uSunDir), 0.0), 4.0) * vT * 1.1;
        vec3 col = alb * (uSunColor * uSunI * (ndl + tr) * vSun * 0.3183 + uSkyAmb * 0.55 * mix(0.5, 1.0, vT));
        col = applyAerial(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'grass';

  function fillSlot(slot, cx, cz) {
    let o = slot * K * 4;
    for (let k = 0; k < K; k++, o += 4) {
      const x = (cx + hash2(cx * 7.1 + k, cz * 3.3 - k)) * CELL, z = (cz + hash2(cz * 5.7 - k * 1.3, cx * 2.9 + k)) * CELL;
      const i = Math.round((x - hf.x0) / hf.res), j = Math.round((z - hf.z0) / hf.res);
      let packed = 0;
      if (i >= 0 && j >= 0 && i < hf.cols && j < hf.rows) {
        const cls = lc[j * hf.cols + i];
        let e = CLS[cls];
        let p = e ? e[0] : 0, type = e ? e[1] : 0, h = e ? e[2] : 0;
        const hit = roadIdx.query(x, z, VERGE_BAND + 0.4, null, tmp);
        if (hit) {
          const out = tmp.d - tmp.seg.hw;            // metres beyond the road/pavement edge
          if (out < 0.4) p = 0;                       // never on carriageway / pavement
          else if (!tmp.seg.ref._pave && cls !== 4 && cls !== 10 && cls !== 5 && cls !== 3 && cls !== 6 && cls !== 9) {
            // rural verge: long rough grass between road and field
            p = Math.max(p, 1.0 - (out - 0.4) / (VERGE_BAND + 0.4) * 0.9); type = 1; h = 0.55;
          }
        }
        if (p > 0 && hash2(x * 1.3, z * 0.7) < p && !bIdx.find(x, z)) {
          packed = type * 4 + h * (0.75 + hash2(z, x) * 0.5);
        }
      }
      inst[o] = x; inst[o + 1] = hf.sample(x, z) - 0.04; inst[o + 2] = z; inst[o + 3] = packed;
    }
  }
  return {
    mesh,
    update(cam) {
      const ccx = Math.floor(cam.position.x / CELL), ccz = Math.floor(cam.position.z / CELL);
      let dirty = false;
      if (cam.position.y - hf.sample(cam.position.x, cam.position.z) > 60) { mesh.visible = false; return; }
      mesh.visible = true;
      for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const slot = (((cz % M) + M) % M) * M + (((cx % M) + M) % M);
        if (slotCell[slot * 2] !== cx || slotCell[slot * 2 + 1] !== cz) {
          slotCell[slot * 2] = cx; slotCell[slot * 2 + 1] = cz;
          fillSlot(slot, cx, cz); dirty = true;
        }
      }
      if (dirty) attr.needsUpdate = true;
    },
  };
}
