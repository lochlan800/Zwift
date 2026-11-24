import * as THREE from 'three';
import { patchMaterial, GRID_GLSL } from './shared.js';

// Hedges, dry-stone walls and fences as extruded profiles along polylines.
const SPEC = { hedge: { w: 1.1, h: 1.7, t: 0 }, wall: { w: 0.5, h: 1.15, t: 1 }, fence: { w: 0.08, h: 1.1, t: 2 } };

export async function createWalls(features, slicer) {
  const list = features.walls || [];
  if (!list.length) return null;
  const pos = [], nor = [], at = [], idx = [];
  let v = 0;
  const vert = (x, y, z, nx, ny, nz, u, hh, t) => { pos.push(x, y, z); nor.push(nx, ny, nz); at.push(u, hh, t); return v++; };
  for (const w of list) {
    const S = SPEC[w.k] || SPEC.fence;
    const p = w.p; if (!p || p.length < 2) continue;
    let L = 0;
    let prev = null;
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[2] - a[2]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      if (i > 0) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][2] - p[i - 1][2]);
      const nx = dz, nz = -dx; // left
      const hw = S.w / 2, y0 = p[i][1] - 0.4, y1 = p[i][1] + S.h;
      const bulge = S.t === 0 ? 0.25 : 0;
      const ids = [
        vert(p[i][0] + nx * hw, y0, p[i][2] + nz * hw, nx, 0, nz, L, 0, S.t),
        vert(p[i][0] + nx * (hw + bulge), y1 - 0.4, p[i][2] + nz * (hw + bulge), nx, 0.3, nz, L, 0.7, S.t),
        vert(p[i][0], y1, p[i][2], 0, 1, 0, L, 1, S.t),
        vert(p[i][0] - nx * (hw + bulge), y1 - 0.4, p[i][2] - nz * (hw + bulge), -nx, 0.3, -nz, L, 0.7, S.t),
        vert(p[i][0] - nx * hw, y0, p[i][2] - nz * hw, -nx, 0, -nz, L, 0, S.t),
      ];
      if (prev) for (let k = 0; k < 4; k++) { const a0 = prev[k], a1 = prev[k + 1], b0 = ids[k], b1 = ids[k + 1]; idx.push(a0, a1, b0, b0, a1, b1); }
      prev = ids;
    }
    await slicer.tick();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aWl', new THREE.Float32BufferAttribute(at, 3));
  g.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
  patchMaterial(mat, {
    key: 'walls',
    vertexPars: 'attribute vec3 aWl; varying vec3 vWl;',
    vertex: { begin_vertex: '$\n vWl = aWl;' },
    fragmentPars: `${GRID_GLSL} varying vec3 vWl; uniform sampler2D uNoise; float hbSun;
      vec3 lin3(vec3 c) { return pow(c, vec3(2.2)); }`,
    fragment: {
      map_fragment: `{
        vec4 n = texture2D(uNoise, vAerialWorld.xz / 1.3 + vAerialWorld.y * 0.4);
        vec4 m = texture2D(uNoise, vAerialWorld.xz / 0.35 + vAerialWorld.y * 0.9);
        int t = int(vWl.z + 0.5);
        vec3 c;
        if (t == 0) c = mix(lin3(vec3(0.16, 0.24, 0.08)), lin3(vec3(0.30, 0.38, 0.14)), m.a) * (0.7 + 0.5 * n.g);
        else if (t == 1) { vec2 st = vec2(vWl.x / 0.35, vAerialWorld.y / 0.18); vec2 f = fract(st + vec2(fract(floor(st.y) * 0.37), 0.0));
          float j = smoothstep(0.0, 0.12, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
          c = lin3(vec3(0.42, 0.39, 0.33)) * (0.6 + 0.4 * j) * (0.75 + 0.35 * m.b); }
        else { float post = step(fract(vWl.x / 2.4), 0.05); c = lin3(vec3(0.33, 0.26, 0.18)) * (0.7 + 0.3 * n.r) * (1.0 - 0.3 * post); }
        diffuseColor.rgb = c;
        hbSun = bakedSun(vAerialWorld);
      }`,
      lights_fragment_begin: THREE.ShaderChunk.lights_fragment_begin.replace('getSunLightInfo( sunLight, directLight );', 'getSunLightInfo( sunLight, directLight ); directLight.color *= hbSun;'),
    },
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'walls';
  return { mesh };
}
