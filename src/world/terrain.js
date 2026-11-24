import * as THREE from 'three';
import { U, GRID_GLSL, patchMaterial } from './shared.js';

const CHUNK = 128; // cells per chunk side (512 m)

// ---- CPU-side textures ------------------------------------------------------

export function makeHeightTexture(hf) {
  const t = new THREE.DataTexture(hf.h, hf.cols, hf.rows, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function makeNormalTexture(hf) {
  const { cols, rows, res } = hf;
  const d = new Uint8Array(cols * rows * 4);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const dx = (hf.at(i + 1, j) - hf.at(i - 1, j)) / (2 * res);
    const dz = (hf.at(i, j + 1) - hf.at(i, j - 1)) / (2 * res);
    let nx = -dx, ny = 1, nz = -dz;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    // concavity -> cheap large-scale AO in alpha
    const c = hf.at(i, j);
    const avg = (hf.at(i - 3, j) + hf.at(i + 3, j) + hf.at(i, j - 3) + hf.at(i, j + 3)) * 0.25;
    const ao = Math.min(1, Math.max(0, 0.85 + (c - avg) * 0.12));
    const k = (j * cols + i) * 4;
    d[k] = (nx * 0.5 + 0.5) * 255; d[k + 1] = (ny * 0.5 + 0.5) * 255; d[k + 2] = (nz * 0.5 + 0.5) * 255; d[k + 3] = ao * 255;
  }
  const t = new THREE.DataTexture(d, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// class -> channel (A: farm, wood, residential, hard | B: mown, scrub, water, allotment); grass = remainder
const CLASS_CH = { 0: -1, 1: 0, 2: 1, 3: 2, 4: 6, 5: 3, 6: 4, 7: 5, 8: 7, 9: 4, 10: 3 };

export function makeSplatTextures(hf, lc) {
  const { cols, rows } = hf;
  const n = cols * rows;
  const w = new Uint8Array(n * 8);
  for (let k = 0; k < n; k++) { const ch = CLASS_CH[lc[k]] ?? -1; if (ch >= 0) w[k * 8 + ch] = 255; }
  // 3x3 blur for soft transitions
  const A = new Uint8Array(n * 4), B = new Uint8Array(n * 4);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const acc = [0, 0, 0, 0, 0, 0, 0, 0]; let cnt = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue;
      const kk = (jj * cols + ii) * 8; const wt = (di === 0 && dj === 0) ? 4 : (di === 0 || dj === 0) ? 2 : 1;
      for (let c = 0; c < 8; c++) acc[c] += w[kk + c] * wt;
      cnt += wt;
    }
    const k = (j * cols + i) * 4;
    for (let c = 0; c < 4; c++) { A[k + c] = acc[c] / cnt; B[k + c] = acc[c + 4] / cnt; }
  }
  const mk = (d) => {
    const t = new THREE.DataTexture(d, cols, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
    t.needsUpdate = true; return t;
  };
  return { splatA: mk(A), splatB: mk(B) };
}

// ---- chunk geometry -----------------------------------------------------------

function chunkGeometry(step) {
  const n = CHUNK / step; // cells per side
  const verts = (n + 1) * (n + 1) + 4 * (n + 1);
  const pos = new Float32Array(verts * 3);
  let v = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    pos[v * 3] = i * step * 4; pos[v * 3 + 1] = 0; pos[v * 3 + 2] = j * step * 4; v++;
  }
  const idx = [];
  const id = (i, j) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i, j + 1), d = id(i + 1, j + 1);
    // diagonal b-c (matches HeightField.sample); CCW from above (+y)
    idx.push(a, c, b, b, c, d);
  }
  // skirts: duplicate border vertices flagged y=-1
  const edges = [
    Array.from({ length: n + 1 }, (_, i) => id(i, 0)),
    Array.from({ length: n + 1 }, (_, j) => id(n, j)),
    Array.from({ length: n + 1 }, (_, i) => id(n - i, n)),
    Array.from({ length: n + 1 }, (_, j) => id(0, n - j)),
  ];
  for (const e of edges) {
    const base = v;
    for (const k of e) { pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = -1; pos[v * 3 + 2] = pos[k * 3 + 2]; v++; }
    for (let q = 0; q < n; q++) {
      const t0 = e[q], t1 = e[q + 1], s0 = base + q, s1 = base + q + 1;
      idx.push(t0, s0, t1, t1, s0, s1);
      idx.push(t0, t1, s0, t1, s1, s0); // both windings, cheap & robust
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// ---- material -----------------------------------------------------------------

const TERRAIN_VERT_PARS = /* glsl */`
uniform sampler2D uHeight;
uniform sampler2D uNormalTex;
uniform vec2 uGridOrigin;
uniform vec2 uGridSize;
uniform float uGridRes;
uniform float uSkirt;
float tH; vec3 tN; vec2 tLocal;
`;

const TERRAIN_FRAG_PARS = /* glsl */`
${GRID_GLSL}
uniform sampler2D uNormalTex;
uniform sampler2D uSplatA;
uniform sampler2D uSplatB;
uniform sampler2D uNoise;
vec3 tAlb; float tRough; vec3 tNw; float tAO; float hbSun;
vec3 lin(float r, float g, float b) { return pow(vec3(r, g, b), vec3(2.2)); }
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
// voronoi: returns cell id in xy, edge distance (cell units) in z
vec3 voro(vec2 p) {
  vec2 ip = floor(p), fp = fract(p);
  float d1 = 8.0, d2 = 8.0; vec2 id = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = h22(ip + g) * 0.8 + 0.1;
    vec2 r = g + o - fp;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = ip + g; } else if (d < d2) { d2 = d; }
  }
  return vec3(id, (sqrt(d2) - sqrt(d1)) * 0.5);
}
float rows(vec2 xz, float ang, float period) {
  float d = dot(xz, vec2(cos(ang), sin(ang))) / period;
  float fw = fwidth(d);
  float r = 0.5 + 0.5 * sin(d * 6.2831853);
  return mix(r, 0.5, smoothstep(0.12, 0.45, fw));
}
void terrainSurface(vec3 w) {
  vec2 uv = gridUV(w.xz);
  vec4 nt = texture2D(uNormalTex, uv);
  vec3 N = normalize(nt.xyz * 2.0 - 1.0);
  tAO = nt.a;
  vec4 sa = texture2D(uSplatA, uv);
  vec4 sb = texture2D(uSplatB, uv);
  vec4 n1 = texture2D(uNoise, w.xz / 260.0);
  vec4 n2 = texture2D(uNoise, w.xz / 41.0);
  vec4 n3 = texture2D(uNoise, w.xz / 7.3);
  vec4 n4 = texture2D(uNoise, w.xz / 1.7);
  // organic edges: push blended weights with noise
  float en = (n3.g - 0.5) * 0.9 + (n2.r - 0.5) * 0.5;
  sa = clamp((sa - 0.5) * 1.6 + 0.5 + en * sa * (1.0 - sa) * 2.0, 0.0, 1.0) * step(0.004, sa);
  sb = clamp((sb - 0.5) * 1.6 + 0.5 + en * sb * (1.0 - sb) * 2.0, 0.0, 1.0) * step(0.004, sb);

  // grass / pasture
  vec3 grass = mix(lin(0.25, 0.33, 0.12), lin(0.36, 0.43, 0.17), n2.g);
  grass = mix(grass, lin(0.46, 0.45, 0.24), smoothstep(0.55, 0.9, n1.r) * 0.55);
  grass = mix(grass, lin(0.20, 0.29, 0.10), smoothstep(0.6, 0.9, n3.b) * 0.5);
  grass *= 0.9 + 0.2 * n4.b;
  float grassB = 0.35 * n4.a + 0.25 * n3.b;

  // farmland fields (voronoi parcels with crop rows)
  vec3 farm = grass; float farmB = grassB;
  if (sa.r > 0.01) {
    vec3 v = voro(w.xz / 165.0);
    float h = h12(v.xy), h2 = h12(v.xy + 7.7);
    float ang = h2 * 3.14159;
    float r = rows(w.xz, ang, 0.7);
    vec3 c;
    float rb = 0.0;
    if (h < 0.32) { c = mix(lin(0.66, 0.55, 0.30), lin(0.58, 0.47, 0.26), n2.b); c *= 0.9 + 0.16 * r; rb = r * 0.4; }
    else if (h < 0.58) { c = mix(lin(0.33, 0.42, 0.13), lin(0.40, 0.48, 0.16), n2.b); c *= 0.86 + 0.22 * r; rb = r * 0.35; }
    else if (h < 0.80) { c = mix(lin(0.36, 0.27, 0.18), lin(0.30, 0.22, 0.15), n3.g); c *= 0.88 + 0.2 * r; rb = r * 0.5; }
    else { c = mix(grass, lin(0.42, 0.48, 0.20), 0.4); rb = grassB; }
    c *= 0.9 + 0.2 * n3.r;
    float margin = smoothstep(0.012, 0.035, v.z);
    farm = mix(mix(grass, lin(0.22, 0.27, 0.10), 0.5), c, margin);
    farmB = mix(grassB, rb + n4.b * 0.2, margin);
  }
  vec3 wood = mix(lin(0.17, 0.18, 0.08), lin(0.25, 0.18, 0.10), n3.g) * (0.8 + 0.4 * n4.b);
  float gardenM = 1.0;
  vec3 lawn = mix(lin(0.27, 0.40, 0.12), lin(0.31, 0.44, 0.14), n2.g) * (0.95 + 0.08 * n4.b);
  lawn = mix(lawn, lin(0.22, 0.33, 0.10), smoothstep(0.55, 0.8, n3.r) * 0.35);
  vec3 resid = lawn;
  vec3 hard = mix(lin(0.40, 0.39, 0.37), lin(0.30, 0.30, 0.29), n3.g) * (0.85 + 0.25 * n4.a);
  hard = mix(hard, lin(0.22, 0.21, 0.19), smoothstep(0.65, 0.85, n2.r) * 0.5);
  float stripe = step(0.5, fract(w.x / 9.0 + n1.r * 0.05));
  vec3 mown = mix(lin(0.28, 0.41, 0.12), lin(0.33, 0.46, 0.15), stripe * 0.6 + n3.b * 0.3) * (0.95 + 0.08 * n4.b);
  vec3 scrub = mix(lin(0.34, 0.33, 0.17), lin(0.16, 0.19, 0.07), smoothstep(0.45, 0.6, n3.b)) * (0.85 + 0.3 * n4.a);
  vec3 mud = lin(0.22, 0.19, 0.13);
  vec2 plot = floor(w.xz / vec2(6.0, 11.0));
  float ph = h12(plot);
  vec3 allot = ph < 0.5 ? lin(0.30, 0.22, 0.14) * (0.8 + 0.3 * rows(w.xz, 0.0, 0.6)) : mix(lin(0.25, 0.38, 0.12), lin(0.34, 0.42, 0.18), ph);

  float wg = clamp(1.0 - dot(sa, vec4(1.0)) - dot(sb, vec4(1.0)), 0.0, 1.0);
  vec3 alb = grass * wg + farm * sa.r + wood * sa.g + resid * sa.b + hard * sa.a + mown * sb.r + scrub * sb.g + mud * sb.b + allot * sb.a;
  float tot = wg + dot(sa, vec4(1.0)) + dot(sb, vec4(1.0));
  alb /= max(tot, 1e-3);
  float rough = mix(0.92, 0.80, (sa.a + sa.b * (1.0 - gardenM)) / max(tot, 1e-3));
  float bmp = (grassB * (wg + sb.r + sb.g) + farmB * sa.r + (n3.g * 0.5 + n4.b * 0.5) * (sa.g + sa.a + sb.b + sa.b)) / max(tot, 1e-3);

  // steep slopes: exposed earth
  float steep = smoothstep(0.86, 0.70, N.y);
  alb = mix(alb, lin(0.33, 0.27, 0.19) * (0.8 + 0.3 * n3.r), steep * 0.75);

  // world-space bump from detail noise
  vec3 dpdx = dFdx(w), dpdy = dFdy(w);
  float bx = dFdx(bmp), by = dFdy(bmp);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (bx * r1 + by * r2);
  float fade = 1.0 - smoothstep(60.0, 220.0, distance(w, cameraPosition));
  tNw = normalize(abs(det) * N - grad * 0.04 * fade);
  tAlb = alb;
  tRough = rough;
  hbSun = bakedSun(w);
}
`;

export function createTerrain(hf, textures) {
  const { heightTex, normalTex, splatA, splatB } = textures;
  U.uGridOrigin.value.set(hf.x0, hf.z0);
  U.uGridSize.value.set(hf.cols, hf.rows);
  U.uGridRes.value = hf.res;
  const uniforms = {
    uHeight: { value: heightTex }, uNormalTex: { value: normalTex },
    uSplatA: { value: splatA }, uSplatB: { value: splatB }, uSkirt: { value: 6 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 0.9 });
  const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;');
  patchMaterial(mat, {
    key: 'terrain', uniforms,
    vertexPars: TERRAIN_VERT_PARS, fragmentPars: TERRAIN_FRAG_PARS,
    vertex: {
      beginnormal_vertex: /* glsl */`
        vec4 tw0 = modelMatrix * vec4(position.x, 0.0, position.z, 1.0);
        vec2 tg = clamp((tw0.xz - uGridOrigin) / uGridRes, vec2(0.0), uGridSize - 1.0);
        ivec2 tgi = ivec2(tg + 0.5);
        tH = texelFetch(uHeight, tgi, 0).r;
        tN = normalize(texelFetch(uNormalTex, tgi, 0).xyz * 2.0 - 1.0);
        tLocal = vec2(tgi) * uGridRes + uGridOrigin - modelMatrix[3].xz;
        vec3 objectNormal = tN;`,
      begin_vertex: /* glsl */`vec3 transformed = vec3(tLocal.x, tH + position.y * uSkirt, tLocal.y);`,
    },
    fragment: {
      map_fragment: 'terrainSurface(vAerialWorld); diffuseColor.rgb = tAlb;',
      roughnessmap_fragment: 'float roughnessFactor = tRough;',
      normal_fragment_begin: `$
        normal = normalize((viewMatrix * vec4(tNw, 0.0)).xyz); nonPerturbedNormal = normal;`,
      lights_fragment_begin: lightsBegin,
      aomap_fragment: 'reflectedLight.indirectDiffuse *= tAO; reflectedLight.indirectSpecular *= tAO;',
    },
  });

  const lodSteps = [1, 2, 4, 8, 16];
  const geos = lodSteps.map(chunkGeometry);
  const group = new THREE.Group();
  group.name = 'terrain';
  const nx = Math.ceil((hf.cols - 1) / CHUNK), nz = Math.ceil((hf.rows - 1) / CHUNK);
  const chunks = [];
  for (let cz = 0; cz < nz; cz++) for (let cx = 0; cx < nx; cx++) {
    const i0 = cx * CHUNK, j0 = cz * CHUNK;
    let mn = Infinity, mx = -Infinity;
    for (let j = j0; j <= Math.min(j0 + CHUNK, hf.rows - 1); j++) for (let i = i0; i <= Math.min(i0 + CHUNK, hf.cols - 1); i++) {
      const h = hf.h[j * hf.cols + i]; if (h < mn) mn = h; if (h > mx) mx = h;
    }
    const m = new THREE.Mesh(geos[3], mat);
    m.position.set(hf.x0 + i0 * hf.res, 0, hf.z0 + j0 * hf.res);
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false; m.updateMatrix();
    const box = new THREE.Box3(new THREE.Vector3(m.position.x, mn - 6, m.position.z),
      new THREE.Vector3(Math.min(m.position.x + CHUNK * hf.res, hf.x0 + hf.width), mx, Math.min(m.position.z + CHUNK * hf.res, hf.z0 + hf.depth)));
    chunks.push({ mesh: m, box });
    group.add(m);
  }

  const frustum = new THREE.Frustum();
  const pm = new THREE.Matrix4();
  let lodDist = [260, 650, 1400, 2800];
  return {
    group, material: mat, chunks,
    setLodScale(s) { lodDist = [260 * s, 650 * s, 1400 * s, 2800 * s]; },
    update(camera) {
      pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(pm);
      const p = camera.position;
      for (const c of chunks) {
        const vis = frustum.intersectsBox(c.box);
        c.mesh.visible = vis;
        if (!vis) continue;
        const d = c.box.distanceToPoint(p);
        let l = 0;
        while (l < 4 && d > lodDist[l]) l++;
        c.mesh.geometry = geos[l];
      }
    },
  };
}
