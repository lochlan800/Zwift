import * as THREE from 'three';
import { patchMaterial } from './shared.js';
import { setPose } from './lifeutil.js';
import { mulberry32 } from './heightfield.js';

// ---------------------------------------------------------------------------------------------
// Birds: flocks circling over fields / the valley, a few crossing the sky, and pigeons on the High
// Street pavements that flutter up when the rider passes. One InstancedMesh (1 draw call, no shadow
// pass); wing flapping happens in the vertex shader from a per-instance phase.
// ---------------------------------------------------------------------------------------------

const PARS = /* glsl */`
attribute vec3 aMisc;     // phase, flap amount (0 folded .. 1 full), unused
attribute float aWing;    // 0 body, 1 wing
`;
const BEGIN = /* glsl */`
vec3 transformed = position;
if (aWing > 0.5) {
  float side = sign(position.x), ax = abs(position.x);
  float fl = aMisc.y;
  float th = (sin(aMisc.x) * 0.85 + 0.15) * fl;
  float bend = th * (0.30 + ax * 0.95);          // wing tips lag and flex more than the root
  transformed.x = side * ax * mix(0.18, cos(bend), fl);
  transformed.y += ax * sin(bend) * fl + (1.0 - fl) * 0.02;
  transformed.z += -0.05 * ax * sin(aMisc.x - 0.6) * fl;
}
`;
const NORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
`;

function birdGeometry() {
  const P = [], N = [], I = [], W = [];
  const add = (geo, wing) => {
    const g = geo.index ? geo : geo;
    const pos = g.attributes.position.array, nor = g.attributes.normal.array, idx = g.index.array, o = P.length / 3;
    for (let i = 0; i < pos.length; i += 3) { P.push(pos[i], pos[i + 1], pos[i + 2]); N.push(nor[i], nor[i + 1], nor[i + 2]); W.push(wing); }
    for (const k of idx) I.push(o + k);
  };
  const body = new THREE.SphereGeometry(1, 8, 6); body.scale(0.075, 0.07, 0.26); add(body, 0);
  const head = new THREE.SphereGeometry(1, 6, 5); head.scale(0.045, 0.045, 0.05); head.translate(0, 0.02, 0.27); add(head, 0);
  const tail = new THREE.BoxGeometry(0.1, 0.012, 0.2, 1, 1, 1); tail.translate(0, 0, -0.33); add(tail, 0);
  // wings: strip of quads along the span (x), chord (z) tapering toward the tip; double sided via two layers
  const SEG = 6;
  for (const s of [-1, 1]) {
    const pos = [], idx = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, x = s * (0.04 + t * 0.62);
      const chord = 0.22 * (1 - t * 0.55);
      pos.push(x, 0.005, chord * 0.5, x, 0.005, -chord * 0.7);
    }
    for (let i = 0; i < SEG; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    // flip so the normal points up for both sides
    const nrm = g.attributes.normal.array; for (let i = 0; i < nrm.length; i += 3) { nrm[i] = 0; nrm[i + 1] = 1; nrm[i + 2] = 0; }
    add(g, 1);
    // underside copy facing down
    const g2 = g.clone(); const i2 = g2.index.array; for (let i = 0; i < i2.length; i += 3) { const t = i2[i + 1]; i2[i + 1] = i2[i + 2]; i2[i + 2] = t; }
    const n2 = g2.attributes.normal.array; for (let i = 0; i < n2.length; i += 3) n2[i + 1] = -1;
    add(g2, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(W, 1));
  g.setIndex(I);
  return g;
}

export function createBirds(scene, hf, lc, features, cfg) {
  const nFlock = cfg.tier === 'low' ? 1 : cfg.tier === 'medium' ? 2 : 3;
  const perFlock = cfg.tier === 'low' ? 8 : cfg.tier === 'medium' ? 10 : 13;
  const nCross = cfg.tier === 'low' ? 2 : cfg.tier === 'medium' ? 3 : 5;
  const nPig = cfg.tier === 'low' ? 5 : cfg.tier === 'medium' ? 9 : 14;
  const N = nFlock * perFlock + nCross + nPig;
  const rnd = mulberry32(31337);

  const geo = birdGeometry();
  const mesh = new THREE.InstancedMesh(geo, null, N);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  const aMisc = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); aMisc.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aMisc', aMisc);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, envMapIntensity: 0.8 });
  patchMaterial(mat, { key: 'birds', vertexPars: PARS, vertex: { beginnormal_vertex: NORMAL, begin_vertex: BEGIN } });
  mesh.material = mat; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false; mesh.name = 'birds';
  scene.add(mesh);

  const dark = [new THREE.Color('#1c1c1e'), new THREE.Color('#2b2a28'), new THREE.Color('#3d3d40'), new THREE.Color('#9a9a98')];
  const pig = [new THREE.Color('#6d737d'), new THREE.Color('#7b7f86'), new THREE.Color('#4f5258'), new THREE.Color('#a49f98')];

  const B = []; // bird records
  const flocks = [];
  const landOk = (x, z) => { if (!lc) return true; const i = Math.round((x - hf.x0) / hf.res), j = Math.round((z - hf.z0) / hf.res); if (i < 0 || j < 0 || i >= hf.cols || j >= hf.rows) return false; const c = lc[j * hf.cols + i]; return c === 0 || c === 1 || c === 7 || c === 4 || c === 6; };
  function placeFlock(f, cx, cz) {
    for (let t = 0; t < 24; t++) {
      const a = rnd() * 6.283, r = 250 + rnd() * 450;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (landOk(x, z)) { f.cx = x; f.cz = z; f.alt = hf.sample(x, z) + 45 + rnd() * 50; return; }
    }
    f.cx = cx + 300; f.cz = cz; f.alt = hf.sample(f.cx, f.cz) + 60;
  }
  for (let f = 0; f < nFlock; f++) {
    const fl = { cx: 0, cz: 0, alt: 80, r: 55 + rnd() * 60, w: (8 + rnd() * 3) * (rnd() < 0.5 ? 1 : -1), a0: rnd() * 6.28, init: false, members: [] };
    flocks.push(fl);
    for (let i = 0; i < perFlock; i++) {
      const b = { kind: 0, fl, da: (rnd() - 0.5) * 0.7, dr: (rnd() - 0.5) * 22, dy: (rnd() - 0.5) * 12, ph: rnd() * 6.28, col: dark[(rnd() * 3) | 0], sc: 1.0 + rnd() * 0.5, x: 0, y: 0, z: 0, yaw: 0, flap: 1, fr: 8 + rnd() * 3 };
      B.push(b); fl.members.push(b);
    }
  }
  for (let i = 0; i < nCross; i++) B.push({ kind: 1, ph: rnd() * 6.28, col: dark[(rnd() * 4) | 0], sc: 1.2 + rnd() * 0.5, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, alt: 0, flap: 1, fr: 7 + rnd() * 3, ready: false, glide: 0 });
  // pigeons on High Street pavements
  const hs = (features.roads || []).filter((r) => r.n === 'High Street' && r._pave > 0 && r.p.length > 1);
  const perchSpots = [];
  for (const r of hs) for (let i = 0; i + 1 < r.p.length; i++) {
    const a = r.p[i], b = r.p[i + 1], l = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1, tx = (b[0] - a[0]) / l, tz = (b[2] - a[2]) / l;
    for (const side of [-1, 1]) { const o = r._w / 2 + r._pave * (0.4 + rnd() * 0.3); perchSpots.push([a[0] + tz * side * o, a[1] + 0.17, a[2] - tx * side * o]); }
  }
  for (let i = 0; i < nPig; i++) {
    const sp = perchSpots.length ? perchSpots[(rnd() * perchSpots.length) | 0] : null;
    B.push({ kind: 2, ph: rnd() * 6.28, col: pig[(rnd() * pig.length) | 0], sc: 0.9 + rnd() * 0.25, x: sp ? sp[0] : 0, y: sp ? sp[1] : -999, z: sp ? sp[2] : 0, hx: 0, hy: 0, hz: 0, yaw: rnd() * 6.28, flap: 0, fr: 14, state: 0, t: 0, vx: 0, vz: 0, vy: 0, sp, peck: rnd() * 6 });
  }

  let time = 0;
  function update(dt, camPos, riderPos, riderYaw, riderSpeed, paused) {
    if (paused) dt = 0;
    if (dt > 0.1) dt = 0.1;
    time += dt;
    for (const f of flocks) {
      if (!f.init || Math.hypot(f.cx - camPos.x, f.cz - camPos.z) > 1000) { placeFlock(f, camPos.x, camPos.z); f.init = true; }
      f.a0 += (f.w / f.r) * dt;
    }
    const arr = mesh.instanceMatrix.array, col = mesh.instanceColor.array, am = aMisc.array;
    let n = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (b.kind === 0) {
        const f = b.fl, a = f.a0 + b.da, r = f.r + b.dr;
        const nx = f.cx + Math.cos(a) * r, nz = f.cz + Math.sin(a) * r, ny = f.alt + b.dy + Math.sin(time * 0.3 + b.ph) * 2.5;
        if (dt > 0) { const dx = nx - b.x, dz = nz - b.z; if (dx * dx + dz * dz > 1e-6 && b.y !== 0) b.yaw = Math.atan2(dx, dz); else if (b.y === 0) b.yaw = a + Math.sign(f.w) * Math.PI / 2; }
        b.x = nx; b.y = ny; b.z = nz; b.ph += dt * b.fr * (0.7 + 0.3 * Math.sin(time + b.da * 5));
        b.flap = 1;
      } else if (b.kind === 1) {
        if (!b.ready || Math.hypot(b.x - camPos.x, b.z - camPos.z) > 900) {
          const a = rnd() * 6.283, r = 350 + rnd() * 250;
          b.x = camPos.x + Math.cos(a) * r; b.z = camPos.z + Math.sin(a) * r; b.alt = 60 + rnd() * 70;
          const ta = a + Math.PI + (rnd() - 0.5) * 1.4, v = 9 + rnd() * 5;
          b.vx = Math.cos(ta) * v; b.vz = Math.sin(ta) * v; b.yaw = Math.atan2(b.vx, b.vz); b.ready = true; b.y = hf.sample(b.x, b.z) + b.alt;
        }
        b.x += b.vx * dt; b.z += b.vz * dt; b.y = hf.sample(b.x, b.z) + b.alt + Math.sin(time * 0.5 + b.ph) * 3;
        b.glide = Math.max(0, b.glide - dt);
        if (b.glide <= 0 && rnd() < dt * 0.15) b.glide = 1.2 + rnd() * 1.5;
        b.flap = b.glide > 0 ? 0.35 : 1; b.ph += dt * b.fr * (b.glide > 0 ? 0.2 : 1);
      } else {
        // pigeon
        if (b.state === 0) { // perched
          b.flap = 0;
          if (!b.sp) continue;
          const dr = Math.hypot(b.x - riderPos.x, b.z - riderPos.z);
          if (dr < 13 && dt > 0) { b.state = 1; b.t = 0; const ax = b.x - riderPos.x, az = b.z - riderPos.z, l = Math.hypot(ax, az) || 1; b.vx = ax / l * 5 + (rnd() - 0.5) * 3; b.vz = az / l * 5 + (rnd() - 0.5) * 3; b.vy = 4.5 + rnd() * 2; b.yaw = Math.atan2(b.vx, b.vz); b.hy = b.y; }
          else if (dr > 260 && dt > 0) { const sp = perchSpots[(rnd() * perchSpots.length) | 0]; // re-seat far from the rider
            const sx = sp[0], sz = sp[2]; if (Math.hypot(sx - camPos.x, sz - camPos.z) < 200 && Math.hypot(sx - camPos.x, sz - camPos.z) > 50) { b.x = sx; b.y = sp[1]; b.z = sz; b.sp = sp; } }
          b.peck += dt;
          b.ph = 0;
        } else {
          b.t += dt; b.flap = 1; b.ph += dt * b.fr;
          b.x += b.vx * dt; b.z += b.vz * dt; b.y += b.vy * dt; b.vy = Math.max(1.0, b.vy - 1.5 * dt);
          if (b.t > 14) { b.state = 0; b.y = -999; b.sp = perchSpots.length ? perchSpots[(rnd() * perchSpots.length) | 0] : null; if (b.sp) { b.x = b.sp[0]; b.y = b.sp[1]; b.z = b.sp[2]; } }
        }
      }
      if (b.y < -900) continue;
      if (Math.hypot(b.x - camPos.x, b.z - camPos.z) > 1100) continue;
      const k = 0.5;
      setPose(arr, n * 16, b.x, b.y + (b.kind === 2 && b.state === 0 ? 0.11 * b.sc * k : 0), b.z, b.yaw, 0, b.sc * (b.kind === 2 ? 0.75 : 1) * 1.0, b.sc * (b.kind === 2 ? 0.75 : 1), b.sc * (b.kind === 2 ? 0.75 : 1));
      col[n * 3] = b.col.r; col[n * 3 + 1] = b.col.g; col[n * 3 + 2] = b.col.b;
      am[n * 3] = b.ph; am[n * 3 + 1] = b.flap; am[n * 3 + 2] = 0;
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; aMisc.needsUpdate = true;
  }
  return { update, mesh, count: () => mesh.count, birds: B };
}
