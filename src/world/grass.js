import * as THREE from 'three';
import { U, AERIAL_GLSL, GRID_GLSL } from './shared.js';
import { hash2 } from './heightfield.js';

// Instanced grass clumps in a toroidal ring of cells around the camera.
const CELL = 6;
const GRASSY = { 0: 1, 6: 1, 9: 1, 7: 1, 3: 0.85, 8: 0.7, 1: 0.0, 2: 0.3 };
const HEIGHT = { 0: 0.55, 6: 0.28, 9: 0.3, 7: 1.0, 3: 0.26, 8: 0.4, 2: 0.8 };

function clumpGeometry(blades) {
  const pos = [], uv = [], idx = [];
  let v = 0;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 1.7;
    const r = 0.05 + ((b * 37) % 11) / 11 * 0.45;
    const bx = Math.cos(a) * r, bz = Math.sin(a) * r;
    const facing = a + 1.3 + b;
    const fx = Math.cos(facing), fz = Math.sin(facing);
    const w = 0.018, h = 0.3 + ((b * 13) % 7) / 7 * 0.28;
    const lean = 0.06 + ((b * 7) % 5) / 5 * 0.1;
    const segs = 2;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const ww = w * (1 - t * 0.9);
      const ox = bx + Math.cos(a) * lean * t * t, oz = bz + Math.sin(a) * lean * t * t;
      pos.push(ox - fx * ww, t * h, oz - fz * ww, ox + fx * ww, t * h, oz + fz * ww);
      uv.push(0, t, 1, t);
      if (s > 0) { const k = v + s * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    v += (segs + 1) * 2;
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export function createGrass(hf, lc, roadIdx, bIdx, cfg) {
  if (cfg.grass <= 0) return null;
  const R = cfg.grassRadius;
  const n = Math.ceil(R / CELL);
  const M = 2 * n + 1;
  const K = Math.round(130 * cfg.grass);
  const total = M * M * K;
  const geo = clumpGeometry(cfg.tier === 'low' ? 6 : 9);
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
    uniforms: { ...U, uR, uCam: { value: new THREE.Vector3() } },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      #include <common>
      attribute vec4 aI; uniform float uR; uniform float uTime; uniform vec2 uWind; uniform sampler2D uNoise; uniform vec3 uSunDir;
      ${GRID_GLSL}
      varying vec3 vWorld; varying vec3 vCol; varying float vT; varying float vSun; varying vec3 vN;
      vec3 lin(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
      void main() {
        float d = distance(aI.xz, cameraPosition.xz);
        float s = aI.w * (1.0 - smoothstep(uR * 0.6, uR, d));
        float ang = fract(sin(dot(aI.xz, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
        float cs = cos(ang), sn = sin(ang);
        vec3 p = position;
        p.xz = mat2(cs, -sn, sn, cs) * p.xz;
        p.y *= s; p.xz *= mix(0.75, 1.0, s) * step(0.001, s);
        float ph = aI.x * 0.31 + aI.z * 0.27;
        float wv = sin(uTime * 1.7 + ph) * 0.5 + sin(uTime * 3.1 + ph * 2.3) * 0.25 + 0.3;
        p.xz += uWind * wv * 0.25 * uv.y * uv.y * s;
        vec3 w = aI.xyz + p;
        vWorld = w; vT = uv.y;
        vec4 n1 = texture2D(uNoise, aI.xz / 260.0), n2 = texture2D(uNoise, aI.xz / 41.0), n3 = texture2D(uNoise, aI.xz / 7.3);
        vec3 grass = aI.w < 0.45 ? mix(lin(0.27, 0.40, 0.12), lin(0.31, 0.44, 0.14), n2.g)
                                 : mix(lin(0.25, 0.33, 0.12), lin(0.36, 0.43, 0.17), n2.g);
        grass = mix(grass, lin(0.46, 0.45, 0.24), smoothstep(0.55, 0.9, n1.r) * 0.55 * step(0.45, aI.w));
        grass = mix(grass, lin(0.20, 0.29, 0.10), smoothstep(0.6, 0.9, n3.b) * 0.5);
        vCol = grass * (0.9 + 0.2 * fract(ph * 7.13));
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
        vec3 alb = vCol * mix(0.9, 1.3, vT);
        vec3 vd = normalize(vWorld - cameraPosition);
        float ndl = max(dot(vN, uSunDir), 0.0) * 0.7 + 0.3;
        float tr = pow(max(dot(vd, uSunDir), 0.0), 4.0) * vT * 1.2;
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
      let sc = 0;
      if (i >= 0 && j >= 0 && i < hf.cols && j < hf.rows) {
        const cls = lc[j * hf.cols + i];
        const p = GRASSY[cls] || 0;
        if (hash2(x * 1.3, z * 0.7) < p && !roadIdx.query(x, z, 0.4, null, tmp) && !bIdx.find(x, z)) {
          sc = (HEIGHT[cls] || 0.5) * (0.8 + hash2(z, x) * 0.45);
        }
      }
      inst[o] = x; inst[o + 1] = hf.sample(x, z) - 0.04; inst[o + 2] = z; inst[o + 3] = sc;
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
