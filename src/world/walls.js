import * as THREE from 'three';
import { patchMaterial, GRID_GLSL, OCC_GLSL } from './shared.js';
import { splitByCell } from './heightfield.js';
import { foliageTexture, FOLIAGE_GLSL } from './trees.js';

// Hedges, dry-stone walls and fences as extruded profiles along polylines.
const SPEC = { hedge: { w: 1.0, h: 1.45, t: 0 }, wall: { w: 0.5, h: 1.15, t: 1 }, fence: { w: 0.08, h: 1.1, t: 2 } };

// 1D value noise for hedge silhouettes
function vn(x, seed) {
  const h = (k) => { let t = Math.imul((k | 0) ^ seed, 2654435761) >>> 0; t ^= t >>> 15; t = Math.imul(t, 2246822519) >>> 0; t ^= t >>> 13; return (t >>> 0) / 4294967296; };
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return h(i) * (1 - u) + h(i + 1) * u;
}

// resample polyline (x,y,z) at ~step metres
function resample(p, step) {
  const out = [p[0]];
  for (let i = 0; i + 1 < p.length; i++) {
    const a = p[i], b = p[i + 1], L = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const n = Math.max(1, Math.round(L / step));
    for (let k = 1; k <= n; k++) { const t = k / n; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return out;
}

export async function createWalls(features, slicer, castShadow = true, roadIdx = null, tier = 'high') {
  const list = features.walls || [];
  if (!list.length) return null;
  const pos = [], at = [], idx = [];
  let v = 0;
  const tmp = { seg: null, d: 0, t: 0, y: 0 };
  const vert = (x, y, z, u, hh, t, run) => { pos.push(x, y, z); at.push(u, hh, t, run); return v++; };
  const hstep = tier === 'low' ? 1.6 : 1.1;
  let seedN = 1;
  for (const w of list) {
    const S = SPEC[w.k] || SPEC.fence;
    if (!w.p || w.p.length < 2) continue;
    const isHedge = S.t === 0;
    const seed = (seedN++ * 7919) | 0;
    const run = vn(seed * 0.37, 11);
    const hBase = isHedge ? 1.3 + run * 0.6 : S.h;
    const p = resample(w.p, isHedge ? hstep : 3);
    let L = 0, prev = null;
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (i > 0) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]);
      // never on a carriageway / pavement; hedges get occasional gaps
      let blocked = roadIdx && roadIdx.query(p[i][0], p[i][2], isHedge ? 0.6 : 0.1, null, tmp);
      if (isHedge && !blocked && p.length > 12 && vn(L / 2.2, seed + 5) > 0.9) blocked = true;
      if (blocked) { prev = null; continue; }
      const nx = dz, nz = -dx; // left
      const x = p[i][0], y = p[i][1], z = p[i][2];
      let ids;
      if (isHedge) {
        const n1 = vn(L / 2.6, seed), n2 = vn(L / 0.8, seed + 1), n3 = vn(L / 6.0, seed + 2);
        let bump = Math.max(0, vn(L / 4.5, seed + 3) - 0.72) * 2.6; // hawthorn-like crowns
        const top = y + hBase * (0.82 + 0.3 * n3) + (n1 - 0.5) * 0.4 + (n2 - 0.5) * 0.24 + (vn(L / 0.37, seed + 9) - 0.5) * 0.12 + bump * 0.6;
        const hw = 0.42 + n1 * 0.17 + bump * 0.15 + (vn(L / 0.5, seed + 4) - 0.5) * 0.12, bl = 0.16 + n2 * 0.18;
        const h = top - y;
        const prof = [[hw * 0.8, -0.35, 0], [hw + bl, h * 0.45, 0.45], [hw * 0.75 + bl * 0.5, h * 0.85, 0.85], [0.05 * (n2 - 0.5), h, 1],
          [-(hw * 0.75 + bl * 0.4), h * 0.86, 0.85], [-(hw + bl * 0.9), h * 0.42, 0.45], [-hw * 0.8, -0.35, 0]];
        ids = prof.map(([o, yy, rel]) => vert(x + nx * o, y + yy, z + nz * o, L, rel, 0, run));
      } else {
        const hw = S.w / 2, y0 = y - 0.4, y1 = y + S.h;
        ids = [vert(x + nx * hw, y0, z + nz * hw, L, 0, S.t, run), vert(x + nx * hw, y1, z + nz * hw, L, 0.9, S.t, run),
          vert(x, y1 + 0.05, z, L, 1, S.t, run), vert(x - nx * hw, y1, z - nz * hw, L, 0.9, S.t, run), vert(x - nx * hw, y0, z - nz * hw, L, 0, S.t, run)];
      }
      if (prev && prev.length === ids.length) for (let k = 0; k + 1 < ids.length; k++) { const a0 = prev[k], a1 = prev[k + 1], b0 = ids[k], b1 = ids[k + 1]; idx.push(a0, a1, b0, b0, a1, b1); }
      prev = ids;
    }
    await slicer.tick();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWl', new THREE.Float32BufferAttribute(at, 4));
  g.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
  patchMaterial(mat, {
    key: 'walls', uniforms: { uFoliage: { value: foliageTexture() } },
    vertexPars: 'attribute vec4 aWl; varying vec4 vWl;',
    vertex: { begin_vertex: '$\n vWl = aWl;' },
    fragmentPars: `${GRID_GLSL} ${OCC_GLSL} ${FOLIAGE_GLSL} varying vec4 vWl; uniform sampler2D uNoise; float hbSun; float wBump;
      vec3 lin3(vec3 c) { return pow(c, vec3(2.2)); }`,
    fragment: {
      map_fragment: `{
        vec4 n = texture2D(uNoise, vAerialWorld.xz / 1.3 + vAerialWorld.y * 0.4);
        vec4 m = texture2D(uNoise, vAerialWorld.xz / 0.35 + vAerialWorld.y * 0.9);
        int t = int(vWl.z + 0.5);
        vec3 c;
        wBump = 0.0;
        if (t == 0) {
          vec3 w = vAerialWorld;
          // hawthorn / blackthorn / privet: small painted leaves on twiggy dark interior
          float l3 = texture2D(uNoise, w.xz / 3.5 + w.y * 0.2).g;
          vec3 tint = mix(vec3(0.80, 0.84, 0.70), vec3(1.15, 1.08, 0.82), mix(l3, vWl.w, 0.5));
          vec4 fs = foliageSurface(w, vec2(0.0, 0.1111), 0.55, tint * vec3(0.6, 0.62, 0.55));
          float cav = fs.a;
          c = fs.rgb * mix(0.35, 1.05, smoothstep(0.0, 0.75, vWl.y)) * mix(0.8, 1.15, smoothstep(0.3, 0.7, vWl.y * l3 + vWl.y * 0.3));
          wBump = cav;
        }
        else if (t == 1) { vec2 st = vec2(vWl.x / 0.35, vAerialWorld.y / 0.18); vec2 f = fract(st + vec2(fract(floor(st.y) * 0.37), 0.0));
          float j = smoothstep(0.0, 0.12, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
          c = lin3(vec3(0.42, 0.39, 0.33)) * (0.6 + 0.4 * j) * (0.75 + 0.35 * m.b); }
        else { float post = step(fract(vWl.x / 2.4), 0.05); c = lin3(vec3(0.33, 0.26, 0.18)) * (0.7 + 0.3 * n.r) * (1.0 - 0.3 * post); }
        diffuseColor.rgb = c;
        hbSun = bakedSun(vAerialWorld);
        if (ign(gl_FragCoord.xy) > occFade(vAerialWorld)) discard;
      }`,
      normal_fragment_begin: `$
        {
          vec3 Nw = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 dpdx = dFdx(vAerialWorld), dpdy = dFdy(vAerialWorld);
          float bx = dFdx(wBump), by = dFdy(wBump);
          vec3 r1 = cross(dpdy, Nw), r2 = cross(Nw, dpdx);
          float det = dot(dpdx, r1);
          float fade = 1.0 - smoothstep(10.0, 50.0, distance(vAerialWorld, cameraPosition));
          Nw = normalize(abs(det) * Nw - sign(det) * (bx * r1 + by * r2) * 0.06 * fade);
          normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
        }`,
      lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;'),
    },
  });
  const mesh = new THREE.Group();
  mesh.name = 'walls';
  for (const sg of splitByCell(g, 400)) {
    const m = new THREE.Mesh(sg, mat);
    m.castShadow = castShadow; m.receiveShadow = true; m.matrixAutoUpdate = false;
    mesh.add(m);
  }
  g.dispose();
  return { mesh };
}
