import * as THREE from 'three';
import { U, AERIAL_GLSL, GRID_GLSL, patchMaterial } from './shared.js';
import { mulberry32, hash2 } from './heightfield.js';

// ---------------------------------------------------------------- textures
function leafAtlas() {
  const W = 512, Hh = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const g = cv.getContext('2d');
  const rnd = mulberry32(77);
  // left: leaf clusters with alpha (many small leaves grouped in sprigs)
  for (let c = 0; c < 70; c++) {
    const a0 = rnd() * Math.PI * 2, r0 = Math.sqrt(rnd()) * 96;
    const cx = 128 + Math.cos(a0) * r0, cy = 128 + Math.sin(a0) * r0;
    const shade = rnd();
    for (let i = 0; i < 34; i++) {
      const a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.7) * 24;
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      if (Math.hypot(x - 128, y - 128) > 124) continue;
      const s = 3 + rnd() * 3.5, rot = a + (rnd() - 0.5);
      const l = 20 + shade * 16 + rnd() * 16 - (r0 < 40 ? 6 : 0);
      g.fillStyle = `hsl(${84 + rnd() * 28}, ${30 + rnd() * 18}%, ${l}%)`;
      g.beginPath(); g.ellipse(x, y, s, s * 0.55, rot, 0, Math.PI * 2); g.fill();
    }
  }
  // right: bark (opaque)
  g.fillStyle = '#4a3d31'; g.fillRect(256, 0, 256, 256);
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(${20 + rnd() * 50},${18 + rnd() * 40},${14 + rnd() * 30},0.5)`;
    g.fillRect(256 + rnd() * 256, rnd() * 256, 2 + rnd() * 5, 20 + rnd() * 80);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function impostorAtlas() {
  const W = 256, Hh = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const g = cv.getContext('2d');
  const rnd = mulberry32(99);
  // left half: deciduous crown silhouette on short trunk
  g.fillStyle = '#3b2f25'; g.fillRect(60, 170, 8, 86);
  for (let i = 0; i < 900; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd());
    const x = 64 + Math.cos(a) * rr * 58, y = 112 + Math.sin(a) * rr * 92;
    const s = 3 + rnd() * 6; const l = 34 + rnd() * 40;
    g.fillStyle = `hsl(${90 + rnd() * 25}, 40%, ${l}%)`;
    g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
  }
  // right half: conifer
  g.fillStyle = '#3b2f25'; g.fillRect(189, 200, 6, 56);
  for (let i = 0; i < 900; i++) {
    const t = rnd(); const y = 8 + t * 220; const half = (t * 0.92 + 0.04) * 56;
    const x = 192 + (rnd() * 2 - 1) * half;
    const s = 2.5 + rnd() * 4; const l = 22 + rnd() * 30;
    g.fillStyle = `hsl(${110 + rnd() * 30}, 35%, ${l}%)`;
    g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ---------------------------------------------------------------- geometry
function pushQuad(arr, c, ax, ay, s, nrmFn, uv0, uv1, leaf, ao) {
  // quad centred at c spanned by unit axes ax, ay with half size s
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const base = arr.pos.length / 3;
  for (const [i, j] of corners) {
    const x = c.x + (ax.x * i + ay.x * j) * s, y = c.y + (ax.y * i + ay.y * j) * s, z = c.z + (ax.z * i + ay.z * j) * s;
    arr.pos.push(x, y, z);
    const n = nrmFn(x, y, z); arr.nor.push(n.x, n.y, n.z);
    arr.uv.push(uv0[0] + (i * 0.5 + 0.5) * (uv1[0] - uv0[0]), uv0[1] + (j * 0.5 + 0.5) * (uv1[1] - uv0[1]));
    arr.t.push(leaf, ao); arr.c.push(c.x, c.y, c.z);
  }
  arr.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function cylinder(arr, x0, y0, z0, x1, y1, z1, r0, r1, seg = 6) {
  const a = new THREE.Vector3(x0, y0, z0), b = new THREE.Vector3(x1, y1, z1);
  const d = b.clone().sub(a).normalize();
  const t = Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(d, t).normalize(), v = new THREE.Vector3().crossVectors(d, u);
  const base = arr.pos.length / 3;
  for (let k = 0; k <= seg; k++) {
    const ang = k / seg * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
    const n = u.clone().multiplyScalar(cs).addScaledVector(v, sn);
    for (const [p, r, vv] of [[a, r0, 0], [b, r1, 1]]) {
      arr.pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
      arr.nor.push(n.x, n.y, n.z);
      arr.uv.push(0.55 + 0.4 * k / seg, vv);
      arr.t.push(0, 0.8); arr.c.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r);
    }
  }
  for (let k = 0; k < seg; k++) { const i = base + k * 2; arr.idx.push(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
}

function buildArr(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(arr.nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(arr.t, 2));
  g.setAttribute('aC', new THREE.Float32BufferAttribute(arr.c, 3));
  g.setIndex(arr.idx);
  return g;
}

// unit deciduous tree: base at y=0, top y=1, crown horizontal radius 1
function deciduousGeo(seed, cards) {
  const rnd = mulberry32(seed);
  const arr = { pos: [], nor: [], uv: [], t: [], c: [], idx: [] };
  const cy = 0.6, ry = 0.38;
  cylinder(arr, 0, -0.05, 0, 0.02, cy + 0.05, 0.01, 0.05, 0.025, 7);
  for (let b = 0; b < 4; b++) {
    const a = b / 4 * Math.PI * 2 + rnd();
    const y0 = 0.32 + rnd() * 0.15;
    cylinder(arr, 0, y0, 0, Math.cos(a) * 0.55, y0 + 0.22 + rnd() * 0.1, Math.sin(a) * 0.55, 0.02, 0.008, 4);
  }
  const ctr = new THREE.Vector3(0, cy, 0);
  const nrm = (x, y, z) => new THREE.Vector3(x, (y - cy) * 1.6, z).normalize();
  for (let i = 0; i < cards; i++) {
    // points in ellipsoid, biased outward
    let p;
    do { p = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1); } while (p.lengthSq() > 1);
    const rr = p.length();
    p.normalize().multiplyScalar(0.35 + 0.65 * Math.pow(rr, 0.5));
    const c = new THREE.Vector3(p.x * 0.8, cy + p.y * ry * 0.85, p.z * 0.8);
    const ax = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.4, rnd() * 2 - 1).normalize();
    const ay = new THREE.Vector3().crossVectors(ax, new THREE.Vector3(rnd() - 0.5, 1, rnd() - 0.5)).normalize();
    const s = 0.24 + rnd() * 0.1;
    const ao = Math.min(1, 0.35 + 0.75 * c.clone().sub(ctr).multiply(new THREE.Vector3(1, 1 / ry, 1)).length());
    pushQuad(arr, c, ax, new THREE.Vector3().crossVectors(ay, ax).normalize(), s, nrm, [0, 0], [0.5, 1], 1, ao);
  }
  return buildArr(arr);
}

function coniferGeo(seed, tiers) {
  const rnd = mulberry32(seed);
  const arr = { pos: [], nor: [], uv: [], t: [], c: [], idx: [] };
  cylinder(arr, 0, -0.05, 0, 0, 0.95, 0, 0.045, 0.01, 6);
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = 0.12 + f * 0.82;
    const rad = (1 - f) * 0.95 + 0.06;
    const n = Math.max(3, Math.round(7 * (1 - f)) + 2);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rnd() * 0.7;
      const c = new THREE.Vector3(Math.cos(a) * rad * 0.55, y, Math.sin(a) * rad * 0.55);
      const ax = new THREE.Vector3(Math.cos(a), -0.35, Math.sin(a)).normalize();
      const ay = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
      const nrm = (x, yy, z) => new THREE.Vector3(x, 0.55, z).normalize();
      pushQuad(arr, c, ax, ay, rad * 0.55 + 0.08, nrm, [0, 0], [0.5, 1], 1, 0.45 + 0.55 * Math.min(1, rad));
    }
  }
  return buildArr(arr);
}

// ---------------------------------------------------------------- main
const DITHER = 'float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }';

export function createTrees(features, hf, opts) {
  const trees = features.trees;
  const N = trees.length;
  // classify species + store compact arrays
  const tx = new Float32Array(N), ty = new Float32Array(N), tz = new Float32Array(N), th = new Float32Array(N), tr = new Float32Array(N);
  const tsp = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const [x, y, z, h, r] = trees[i];
    tx[i] = x; ty[i] = y; tz[i] = z; th[i] = Math.max(2.5, h); tr[i] = Math.max(0.8, Math.min(r, h * 0.7));
    const hs = hash2(x, z);
    tsp[i] = (tr[i] < th[i] * 0.24 && hs < 0.7) || hs < 0.07 ? 1 : 0;
  }
  // spatial grid
  const CELL = 64;
  const gx = Math.ceil(hf.width / CELL) + 1, gz = Math.ceil(hf.depth / CELL) + 1;
  const cellStart = new Int32Array(gx * gz + 1);
  const cellOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const cx = Math.min(gx - 1, Math.max(0, Math.floor((tx[i] - hf.x0) / CELL)));
    const cz = Math.min(gz - 1, Math.max(0, Math.floor((tz[i] - hf.z0) / CELL)));
    cellOf[i] = cz * gx + cx; cellStart[cellOf[i] + 1]++;
  }
  for (let c = 0; c < gx * gz; c++) cellStart[c + 1] += cellStart[c];
  const order = new Int32Array(N); const fill = cellStart.slice(0, gx * gz);
  for (let i = 0; i < N; i++) order[fill[cellOf[i]]++] = i;

  const leafTex = leafAtlas();
  const group = new THREE.Group(); group.name = 'trees';

  // --- near detailed trees (InstancedMesh, lit, shadowed)
  const fadeBand = 30;
  const uNear = { value: opts.nearRadius };
  const mat = new THREE.MeshStandardMaterial({ map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.82, metalness: 0, envMapIntensity: 0.8 });
  patchMaterial(mat, {
    key: 'treesNear', uniforms: { uNear },
    vertexPars: `attribute vec2 aT; attribute vec3 aC; varying vec2 vT; varying float vIDist; uniform float uTime; uniform float uNear; uniform vec2 uWind;`,
    vertex: {
      begin_vertex: `$
        vT = aT;
        {
          // keep leaf cards isotropic under the non-uniform (r, h, r) instance scale
          float sx = length(instanceMatrix[0].xyz), sy = length(instanceMatrix[1].xyz);
          vec3 off = position - aC;
          transformed = aC + off * vec3(1.0, sx / sy, 1.0);
        }
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        vIDist = distance(ip, cameraPosition);
        float ph = ip.x * 0.13 + ip.z * 0.17;
        float sway = sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25;
        float flutter = sin(uTime * 7.0 + position.x * 9.0 + position.z * 7.0 + ph) * 0.012 * aT.x;
        transformed.xz += uWind * (sway * 0.025 * position.y * position.y) + flutter;
        transformed.y += flutter * 0.5;`,
    },
    fragmentPars: `${GRID_GLSL} varying vec2 vT; varying float vIDist; uniform float uNear; ${DITHER} float hbSun;`,
    fragment: {
      map_fragment: `$
        {
          float fade = smoothstep(uNear - ${fadeBand.toFixed(1)}, uNear, vIDist);
          if (ign(gl_FragCoord.xy) < fade) discard;
        }`,
      lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;'),
      normal_fragment_begin: `$
        hbSun = texture2D(uShadowBake, gridUV(vAerialWorld.xz)).r;`,
      aomap_fragment: `float tao = mix(1.0, vT.y, 0.85);
        reflectedLight.indirectDiffuse *= tao; reflectedLight.directDiffuse *= mix(1.0, vT.y, 0.5); reflectedLight.indirectSpecular *= tao;
        {
          vec3 vd = normalize(vAerialWorld - cameraPosition);
          float tr = pow(max(dot(vd, uSunDir), 0.0), 5.0) * vT.x * hbSun;
          reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * tr * 1.4;
        }`,
    },
  });
  mat.vertexColors = false;
  const depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: leafTex, alphaTest: 0.45, side: THREE.DoubleSide });

  const cards = opts.tier === 'low' ? 24 : 42;
  const variants = [deciduousGeo(11, cards), deciduousGeo(23, cards), coniferGeo(5, opts.tier === 'low' ? 6 : 9)];
  const MAXN = opts.maxNear;
  const nearMeshes = variants.map((geo) => {
    const m = new THREE.InstancedMesh(geo, mat, MAXN);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXN * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0; m.frustumCulled = false;
    m.castShadow = true; m.receiveShadow = true;
    m.customDepthMaterial = depthMat;
    group.add(m);
    return m;
  });
  // vColor must exist: enable instance color define via vertexColors false; three defines USE_INSTANCING_COLOR -> vColor
  const tint = (i, out, o) => {
    const h = hash2(tx[i] * 1.7, tz[i] * 1.3), h2 = hash2(tz[i], tx[i]);
    let r, g, b;
    if (tsp[i]) { r = 0.62 + h * 0.15; g = 0.75 + h * 0.15; b = 0.62 + h2 * 0.15; }
    else { r = 0.85 + h * 0.35 - h2 * 0.1; g = 0.85 + h * 0.2; b = 0.55 + h2 * 0.3; if (h2 > 0.85) { r += 0.25; g += 0.05; } }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
  };

  // --- far impostors (all trees)
  const farGeo = new THREE.InstancedBufferGeometry();
  farGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  farGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const a1 = new Float32Array(N * 4), a2 = new Float32Array(N * 4);
  const col = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    a1[i * 4] = tx[i]; a1[i * 4 + 1] = ty[i] - 0.3; a1[i * 4 + 2] = tz[i]; a1[i * 4 + 3] = th[i];
    tint(i, col, 0);
    a2[i * 4] = tr[i]; a2[i * 4 + 1] = tsp[i]; a2[i * 4 + 2] = col[0]; a2[i * 4 + 3] = col[2];
  }
  farGeo.setAttribute('aA', new THREE.InstancedBufferAttribute(a1, 4));
  farGeo.setAttribute('aB', new THREE.InstancedBufferAttribute(a2, 4));
  farGeo.instanceCount = N;
  farGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const farMat = new THREE.ShaderMaterial({
    uniforms: { ...U, uImp: { value: impostorAtlas() }, uNear, uEnvAmb: { value: new THREE.Color(0.35, 0.42, 0.55) } },
    vertexShader: /* glsl */`
      #include <common>
      attribute vec4 aA; attribute vec4 aB;
      uniform float uNear; uniform vec3 uSunDir; uniform float uTime;
      ${GRID_GLSL}
      varying vec2 vUv; varying vec3 vWorld; varying vec3 vTint; varying float vFade; varying vec3 vRight; varying vec3 vToCam; varying float vSun; varying float vSp;
      void main() {
        vec3 base = aA.xyz; float h = aA.w; float r = aB.x;
        vec3 toCam = cameraPosition - base; toCam.y = 0.0;
        float d = length(toCam);
        toCam /= max(d, 1e-3);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x);
        float w = r * (aB.y > 0.5 ? 1.05 : 1.12);
        vec3 p = base + right * position.x * w + vec3(0.0, position.y * h * 1.02, 0.0);
        p += toCam * r * 0.3;
        vUv = vec2(position.x * 0.5 + 0.5, position.y);
        vWorld = p; vTint = vec3(aB.z, (aB.z + aB.w) * 0.5, aB.w);
        vFade = smoothstep(uNear - 30.0, uNear, distance(base, cameraPosition));
        vRight = right; vToCam = toCam; vSp = aB.y;
        vSun = texture2D(uShadowBake, gridUV(base.xz)).r;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        if (vFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D uImp; uniform vec3 uEnvAmb; uniform float uSunI; uniform vec3 uSkyAmb;
      ${AERIAL_GLSL}
      ${DITHER}
      varying vec2 vUv; varying vec3 vWorld; varying vec3 vTint; varying float vFade; varying vec3 vRight; varying vec3 vToCam; varying float vSun; varying float vSp;
      void main() {
        if (ign(gl_FragCoord.xy) > vFade) discard;
        vec2 uv = vec2(vUv.x * 0.5 + (vSp > 0.5 ? 0.5 : 0.0), vUv.y);
        vec4 t = texture2D(uImp, uv);
        if (t.a < 0.5) discard;
        vec3 alb = t.rgb * vTint;
        // spherical normal approximation
        vec2 q = vec2(vUv.x * 2.0 - 1.0, (vUv.y - 0.55) * 2.2);
        float z = sqrt(max(0.0, 1.0 - dot(q, q) * 0.6));
        vec3 n = normalize(vRight * q.x + vec3(0.0, 1.0, 0.0) * q.y * 0.8 + vToCam * z);
        float ndl = max(dot(n, uSunDir), 0.0) * 0.85 + 0.15;
        vec3 vd = normalize(vWorld - cameraPosition);
        float tr = pow(max(dot(vd, uSunDir), 0.0), 5.0) * 0.6;
        vec3 col = alb * (uSunColor * uSunI * (ndl * 0.8 + tr) * vSun * 0.3183 + uSkyAmb * 0.55 * (0.55 + 0.45 * vUv.y));
        col = applyAerial(col, vWorld);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const far = new THREE.Mesh(farGeo, farMat);
  far.frustumCulled = false;
  group.add(far);

  // --- near set maintenance
  const last = new THREE.Vector3(1e9, 0, 0);
  const counts = [0, 0, 0];
  function rebuild(cam) {
    counts[0] = counts[1] = counts[2] = 0;
    const R = uNear.value + 5, R2 = R * R;
    const cx0 = Math.max(0, Math.floor((cam.x - R - hf.x0) / CELL)), cx1 = Math.min(gx - 1, Math.floor((cam.x + R - hf.x0) / CELL));
    const cz0 = Math.max(0, Math.floor((cam.z - R - hf.z0) / CELL)), cz1 = Math.min(gz - 1, Math.floor((cam.z + R - hf.z0) / CELL));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const c = cz * gx + cx;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const i = order[k];
        const dx = tx[i] - cam.x, dz = tz[i] - cam.z;
        if (dx * dx + dz * dz > R2) continue;
        const v = tsp[i] ? 2 : (i & 1);
        const m = nearMeshes[v];
        const n = counts[v];
        if (n >= MAXN) continue;
        counts[v]++;
        const e = m.instanceMatrix.array, o = n * 16;
        const ang = hash2(tx[i], tz[i] * 3.1) * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
        const r = tr[i], h = th[i];
        e[o] = r * cs; e[o + 1] = 0; e[o + 2] = -r * sn; e[o + 3] = 0;
        e[o + 4] = 0; e[o + 5] = h; e[o + 6] = 0; e[o + 7] = 0;
        e[o + 8] = r * sn; e[o + 9] = 0; e[o + 10] = r * cs; e[o + 11] = 0;
        e[o + 12] = tx[i]; e[o + 13] = ty[i] - 0.3; e[o + 14] = tz[i]; e[o + 15] = 1;
        tint(i, m.instanceColor.array, n * 3);
      }
    }
    for (let v = 0; v < 3; v++) {
      const m = nearMeshes[v];
      m.count = counts[v];
      m.instanceMatrix.clearUpdateRanges(); m.instanceMatrix.addUpdateRange(0, counts[v] * 16); m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges(); m.instanceColor.addUpdateRange(0, counts[v] * 3); m.instanceColor.needsUpdate = true;
    }
  }
  return {
    group, count: N, farMaterial: farMat,
    setNearRadius(r) { uNear.value = r; last.set(1e9, 0, 0); },
    update(cam) {
      const dx = cam.x - last.x, dz = cam.z - last.z;
      if (dx * dx + dz * dz > 64) { rebuild(cam); last.copy(cam); }
    },
  };
}
