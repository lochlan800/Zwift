import './style.css';
import * as THREE from 'three';
import { SunLight } from 'three/examples/jsm/lights/SunLight.js';
import { loadData } from './data.js';
import { HeightField, PolygonIndex, Slicer, nextFrame } from './world/heightfield.js';
import { U, makeNoiseTexture } from './world/shared.js';
import { createSky } from './world/sky.js';
import { createTerrain, makeHeightTexture, makeNormalTexture, makeSplatTextures } from './world/terrain.js';
import { annotateRoads, buildRoadIndex, conformTerrain, createRoads, roadInfo } from './world/roads.js';
import { createBuildings, shopUnits, pubFronts } from './world/buildings.js';
import { createTrees } from './world/trees.js';
import { createWater, carveWater } from './world/water.js';
import { createGrass } from './world/grass.js';
import { createWalls } from './world/walls.js';
import { bakeShadows } from './world/shadowbake.js';
import { generateHedgerows, createStreetLife } from './world/streetlife.js';
import { markTownCentre, markQuarryHill, quarryTrees, quarryPub, markStorrs, storrsTrees, storrsVerge, classifyAges } from './world/towncentre.js';
import { SegmentIndex, distanceCull } from './world/heightfield.js';
import { createRider } from './ride/rider.js';
import { createAudio } from './audio/audio.js'; // [audio hook] procedural sound, see src/audio
import { createPeople } from './world/people.js';
import { createBirds } from './world/birds.js';
import { createTraffic } from './world/traffic.js'; // street life (traffic / people / birds): sky-lighting agent hook

import { Route, Physics } from './ride/route.js';
import { ChaseCamera } from './ride/camera.js';
import { Hud, fmtTime } from './ui/hud.js';
import { createPost } from './render/post.js';
import { detectTier, DynamicResolution } from './render/quality.js';
import { createWeather, setWeather, getWeather, onWeatherEvent } from './world/weather.js'; // WEATHER
import { initWeatherUI } from './ui/weatherui.js'; // WEATHER

const $ = (id) => document.getElementById(id);
const cfg = detectTier();
const NODYN = new URLSearchParams(location.search).has('nodyn');
const ui = {
  title: $('title'), hud: $('hud'), pause: $('pause'), ride: $('rideBtn'), fill: $('loadFill'), text: $('loadText'),
  loader: $('loader'), attrib: $('attrib'), routeInfo: $('routeInfo'), glerr: $('glerror'),
};

function fatal(title, msg) {
  $('glErrTitle').textContent = title; $('glErrText').textContent = msg;
  ui.glerr.classList.remove('hidden');
}
$('reloadBtn').onclick = () => location.reload();

function progress(f, label) {
  ui.fill.style.width = `${Math.round(Math.min(1, f) * 100)}%`;
  if (label) ui.text.textContent = label;
}

// ---------------------------------------------------------------- renderer
const canvas = $('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, depth: true, alpha: false });
} catch (e) {
  fatal('WebGL unavailable', 'Your browser could not create a WebGL 2 context. Try a recent Chrome, Safari or Firefox.');
  throw e;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
renderer.setClearColor(0x8fb3d9);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(cfg.mobile ? 62 : 58, 1, 0.35, 9000);
camera.position.set(0, 200, 300);

let post, dynres;
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = dynres ? dynres.current() : Math.min(window.devicePixelRatio || 1, cfg.dprCap);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  if (post) post.composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = (w / h < 0.8 ? 70 : cfg.mobile ? 62 : 58);
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- world
const world = {};
const state = { mode: 'loading', s: 0, dist: 0, time: 0, speed: 0, grade: 0, elev: 0, lean: 0, heading: 0, groundY: 0, off: 1.2 };

async function build() {
  const slicer = new Slicer(cfg.mobile ? 24 : 30);
  const data = await loadData(progress);
  const { meta, features } = data;
  ui.attrib.textContent = (meta.attribution || '') + ' Street-level reference: Mapillary contributors (CC BY-SA 4.0).';
  progress(0.1, 'Shaping terrain');
  await nextFrame();
  const hf = new HeightField(meta, data.height);
  // drop duplicate / overlapping footprints (coplanar walls would z-fight)
  {
    const area = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a / 2); };
    const list = features.buildings.filter((b) => b.p && b.p.length >= 3).sort((a, b) => area(b.p) - area(a.p));
    const acc = new PolygonIndex(24), keep = [];
    let dropped = 0;
    for (const b of list) {
      const n = b.p.length; let cx = 0, cz = 0; for (const q of b.p) { cx += q[0] / n; cz += q[1] / n; }
      let inside = acc.find(cx, cz) ? 1 : 0;
      for (const q of b.p) if (acc.find(q[0] * 0.9 + cx * 0.1, q[1] * 0.9 + cz * 0.1)) inside++;
      if (inside > n * 0.6) { dropped++; continue; }
      acc.add(b.p, b); keep.push(b);
    }
    features.buildings = keep;
    console.info('duplicate buildings dropped', dropped);
  }
  annotateRoads(features, hf, data.landcover);
  const tc = markTownCentre(features, hf, data.landcover);
  const qh = markQuarryHill(features);
  const st = markStorrs(features);
  console.info('storrs hill segments', st.roads.length, 'verge nodes', storrsVerge(st, hf, data.landcover));
  console.info('town centre', tc.roads.length, 'roads,', tc.fronting, 'fronting buildings, paved', tc.paved, 'crossings', tc.crossings.map((c) => c.note).join('; '));
  const roadIdx = buildRoadIndex(features);
  conformTerrain(hf, features);
  carveWater(hf, features);
  const bIdx = new PolygonIndex(24);
  for (const b of features.buildings) if (b.p && b.p.length >= 3) bIdx.add(b.p, b);
  world.hf = hf; world.roadIdx = roadIdx; world.bIdx = bIdx; world.features = features;
  const hedgerows = generateHedgerows(features, hf, data.landcover, roadIdx, bIdx);
  for (const w of hedgerows.walls) features.walls.push(w);
  for (const t of hedgerows.trees) features.trees.push(t);
  console.info('ages', JSON.stringify(classifyAges(features, bIdx)));
  const qTrees = quarryTrees(qh, hf, bIdx); for (const t of qTrees) features.trees.push(t);
  for (const t of storrsTrees(st, hf, bIdx)) features.trees.push(t);
  const qPub = quarryPub(qh, features, tc.tcIdx);
  console.info('quarry hill roads', qh.roads.length, 'trees', qTrees.length, 'pub', qPub ? JSON.stringify(qPub.p[0]) : 'none');
  {
    // keep tree trunks >= 1 m clear of carriageway edges and off pavements
    const q0 = { seg: null, d: 0, t: 0, y: 0 };
    let moved = 0;
    for (const t of features.trees) {
      const q = roadIdx.query(t[0], t[2], 1.2, (s) => s.ref._w >= 2.5, q0);
      if (!q) continue;
      const s = q.seg, need = s.ref._w / 2 + (s.ref._pave || 0) + 1.0;
      if (q.d >= need) continue;
      const px = s.ax + (s.bx - s.ax) * q.t, pz = s.az + (s.bz - s.az) * q.t;
      let dx = t[0] - px, dz = t[2] - pz, l = Math.hypot(dx, dz);
      if (l < 1e-3) { dx = -(s.bz - s.az); dz = s.bx - s.ax; l = Math.hypot(dx, dz) || 1; }
      t[0] = px + dx / l * need; t[2] = pz + dz / l * need; t[1] = Math.min(t[1], hf.sample(t[0], t[2]));
      t[1] = hf.sample(t[0], t[2]);
      if (bIdx.find(t[0], t[2])) t[3] = 0; // would land in a building: drop
      moved++;
    }
    features.trees = features.trees.filter((t) => t[3] > 0);
    console.info('trees moved off roads', moved);
  }
  const routeIdx = new SegmentIndex(24);
  { const rp = features.route.pts; for (let i = 0; i + 1 < rp.length; i++) routeIdx.add(rp[i][0], rp[i][1], rp[i][2], rp[i + 1][0], rp[i + 1][1], rp[i + 1][2], 0, null); }

  progress(0.14, 'Building sky');
  await nextFrame();
  const sky = createSky(renderer);
  scene.add(sky.dome);
  scene.environment = sky.envMap;
  scene.environmentIntensity = 0.55; // sky-lighting hook: strong blue sky fill so shadows stay readable (~50% of lit)
  U.uNoise.value = makeNoiseTexture(256);
  world.sky = sky;

  const sun = new SunLight(0xffffff, 6.6);
  sun.color.copy(sky.sunColor);
  U.uSunI.value = sun.intensity;
  sun.position.copy(sky.sunDir);
  sun.castShadow = true;
  sun.shadow.mapSize.set(cfg.shadowMap, cfg.shadowMap);
  sun.shadow.camera.far = cfg.shadowFar;
  sun.shadow.camera.near = 0.5;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = cfg.tier === 'low' ? 1.5 : 2.5;
  scene.add(sun);
  world.sun = sun;
  U.uBakeFade.value.set(cfg.shadowFar * 0.55, cfg.shadowFar * 0.95);

  progress(0.16, 'Baking long shadows');
  const bake = await bakeShadows(hf, features, sky.sunDir, slicer, (f) => progress(0.16 + f * 0.3));
  U.uShadowBake.value = bake.texture;

  progress(0.47, 'Painting land cover');
  await nextFrame();
  const heightTex = makeHeightTexture(hf);
  const normalTex = makeNormalTexture(hf);
  await slicer.tick();
  const { splatA, splatB } = makeSplatTextures(hf, data.landcover);
  const terrain = createTerrain(hf, { heightTex, normalTex, splatA, splatB });
  terrain.setLodScale(cfg.lod);
  scene.add(terrain.group);
  world.terrain = terrain;

  progress(0.55, 'Laying roads');
  await nextFrame();
  const roads = await createRoads(features, hf, data.landcover, roadIdx, slicer, bIdx);
  scene.add(roads.mesh);


  progress(0.62, 'Raising buildings');
  const buildings = await createBuildings(features, slicer, (f) => progress(0.62 + f * 0.2, `Raising buildings ${Math.round(f * 100)}%`), tc.tcIdx, roadIdx, bIdx, hf);
  scene.add(buildings.group);
  world.buildings = buildings;
  const street = createStreetLife(features, hf, data.landcover, roadIdx, bIdx, routeIdx, roads.giveWays, cfg, tc, shopUnits, pubFronts, qh, st);
  console.info('landmarks', JSON.stringify(tc.landmarks), 'street trees', tc.streetTrees, 'gap fills', buildings.fills);
  scene.add(street.group);
  world.street = street;
  console.info('street life', JSON.stringify(street.counts), 'hedgerows', hedgerows.walls.length, 'hedgerow trees', hedgerows.trees.length);

  progress(0.83, 'Planting trees');
  await nextFrame();
  const trees = createTrees(features, hf, { nearRadius: cfg.treeNear, maxNear: cfg.maxNear, tier: cfg.tier });
  scene.add(trees.group);
  world.trees = trees;

  const water = createWater(features, hf);
  if (water) scene.add(water.mesh);
  const walls = await createWalls(features, slicer, cfg.tier !== 'low', roadIdx, cfg.tier);
  world.walls = walls; world.roads = roads;
  if (walls) scene.add(walls.mesh);

  progress(0.9, 'Growing grass');
  await nextFrame();
  const grass = createGrass(hf, data.landcover, roadIdx, bIdx, cfg, heightTex);
  if (grass) scene.add(grass.mesh);
  world.grass = grass;

  progress(0.94, 'Fitting the bike');
  const route = new Route(features.route);
  world.route = route;
  try { world.traffic = createTraffic(scene, features, hf, cfg, { tc }); } catch (e) { console.error('traffic failed', e); }
  try { world.people = createPeople(scene, world.traffic.graph, features, cfg, { traffic: world.traffic }); } catch (e) { console.error('people failed', e); }
  try { world.birds = createBirds(scene, hf, data.landcover, features, cfg); } catch (e) { console.error('birds failed', e); }
  const rider = createRider();
  scene.add(rider.root);
  world.rider = rider;
  world.audio = createAudio(); // [audio hook]
  world.chase = new ChaseCamera(camera, hf, bIdx, route);
  world.physics = new Physics();
  world.hud = new Hud(route, features.route.name || 'Horbury Loop');
  ui.routeInfo.textContent = `${features.route.name || 'Horbury Loop'} · ${(route.length / 1000).toFixed(1)} km · ${Math.round(route.climb)} m climbing`;

  post = createPost(renderer, scene, camera, cfg);
  dynres = new DynamicResolution(renderer, resize, cfg);
  // WEATHER: state machine + rain/splash/leaf/lightning particles; drives sky/fog/light via shared uniforms
  world.weather = createWeather({ scene, camera, renderer, sun: world.sun, sky: world.sky, cfg, hf, heightTex, features, getPost: () => post });
  world.audio?.bindWeather({ onWeatherEvent }); // [audio hook] thunder from lightning events
  resize();
  placeRider(0, 0);

  // warm up shaders
  progress(0.97, 'Compiling shaders');
  await nextFrame();
  try { renderer.compile(scene, camera); } catch (e) { /* ignore */ }
  progress(1, 'Ready');
  ui.ride.disabled = false;
  ui.ride.classList.add('ready');
  ui.loader.style.opacity = '0.6';
  state.mode = 'title';
}

// ---------------------------------------------------------------- ride logic
const P = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), tmpQ = { seg: null, d: 0, t: 0, y: 0 };
let prevHeading = null;
function placeRider(dt, speed) {
  const { route, rider, roadIdx, hf } = world;
  route.at(state.s, P, true);
  route.at(state.s + 3, A); route.at(state.s - 3, B);
  const dx = A.x - B.x, dz = A.z - B.z;
  const heading = Math.atan2(dx, dz);
  const l = Math.hypot(dx, dz) || 1;
  // UK: keep left of the centreline (offset scaled to the carriageway width)
  const lx = dz / l, lz = -dx / l;
  const rq = roadIdx.query(P.x, P.z, 1.0, null, tmpQ);
  const roadW = rq ? rq.seg.ref._w : 6;
  // route.pts is already the left-of-centre riding line when route.side is given
  const wantOff = world.features.route.side ? 0 : roadW >= 4.5 ? Math.min(1.4, roadW * 0.5 - 1.0) : Math.max(0, roadW * 0.5 - 0.9);
  state.off = dt > 0 ? state.off + (wantOff - state.off) * Math.min(1, dt * 1.5) : wantOff;
  const off = state.off;
  P.x += lx * off; P.z += lz * off;
  // ground: road surface under the wheels if available
  let gy = P.y;
  const ry = P.y;
  const q = roadIdx.query(P.x, P.z, 0.5, (s) => Math.abs((s.ay + s.by) * 0.5 - ry) < 1.5, tmpQ);
  if (q && Math.abs(q.y - P.y) < 1.5) gy = q.y + (roadInfo(q.seg.ref)?.lift ?? 0.06);
  else gy = Math.max(P.y + 0.05, hf.sample(P.x, P.z) + 0.05);
  state.groundY = dt > 0 ? state.groundY + (gy - state.groundY) * Math.min(1, dt * 10) : gy;
  // lean from yaw rate
  if (prevHeading !== null && dt > 0) {
    let dh = heading - prevHeading;
    if (dh > Math.PI) dh -= Math.PI * 2; if (dh < -Math.PI) dh += Math.PI * 2;
    const yawRate = dh / dt;
    const target = Math.max(-0.4, Math.min(0.4, Math.atan((speed * yawRate) / 9.81)));
    state.lean += (target - state.lean) * Math.min(1, dt * 3);
  }
  prevHeading = heading;
  rider.root.position.set(P.x, state.groundY, P.z);
  rider.root.rotation.set(0, 0, 0);
  rider.root.rotateY(heading);
  rider.root.rotateX(-Math.atan(state.grade) * 0.9);
  state.heading = heading;
  return state.lean;
}

function startRide() {
  if (state.mode !== 'title') return;
  ui.title.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  world.hud.resize();
  state.mode = 'ride';
  state.s = 0; state.dist = 0; state.time = 0;
  world.physics.v = 2.5;
  world.chase.initialized = false;
  world.audio?.start(); // [audio hook] first user gesture: create/resume AudioContext
}
ui.ride.addEventListener('click', startRide);
function setCamMode(mode) {
  world.chase.setMode(mode);
  $('camLabel').textContent = mode ? 'Drone' : 'Chase';
  $('camBtn').classList.toggle('drone', !!mode);
  // ranges suited to a high viewpoint
  world.sun.shadow.camera.far = mode ? cfg.shadowFar * (cfg.tier === 'low' ? 1.3 : 2.2) : cfg.shadowFar;
  U.uBakeFade.value.set(world.sun.shadow.camera.far * 0.55, world.sun.shadow.camera.far * 0.95);
  world.trees.setNearRadius(mode ? (cfg.tier === 'low' ? cfg.treeNear * 1.2 : Math.max(cfg.treeNear, 260)) : cfg.treeNear);
  world.terrain.setLodScale(mode ? cfg.lod * 1.3 : cfg.lod);
  world.street.setRadiusScale(mode ? (cfg.tier === 'low' ? 1.1 : 1.8) : 1);
}
$('camBtn').addEventListener('click', () => setCamMode(world.chase.mode ? 0 : 1));
$('pauseBtn').addEventListener('click', () => {
  if (state.mode !== 'ride') return;
  state.mode = 'paused';
  $('pauseStats').innerHTML = `<div>Distance<b>${(state.dist / 1000).toFixed(2)} km</b></div><div>Time<b>${fmtTime(state.time)}</b></div>`
    + `<div>Avg speed<b>${(state.time > 0 ? state.dist / state.time * 3.6 : 0).toFixed(1)} km/h</b></div><div>Power<b>220 W</b></div>`;
  ui.pause.classList.remove('hidden');
  world.audio?.pause(); // [audio hook]
});
$('resumeBtn').addEventListener('click', () => { ui.pause.classList.add('hidden'); state.mode = 'ride'; world.audio?.resume(); }); // [audio hook]
$('exitBtn').addEventListener('click', () => {
  ui.pause.classList.add('hidden'); ui.hud.classList.add('hidden'); ui.title.classList.remove('hidden');
  state.mode = 'title'; state.s = 0; placeRider(0, 0);
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && state.mode === 'title' && !ui.ride.disabled) startRide();
  if ((e.key === 'c' || e.key === 'v') && state.mode === 'ride') $('camBtn').click();
  if (e.key === 'Escape' || e.key === 'p') { if (state.mode === 'ride') $('pauseBtn').click(); else if (state.mode === 'paused') $('resumeBtn').click(); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state.mode === 'ride') $('pauseBtn').click(); });

// ---------------------------------------------------------------- loop
let lastT = performance.now(), contextLost = false, titleT = 0, frameNo = 0;
const center = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const dtMs = now - lastT; lastT = now;
  if (contextLost || state.mode === 'loading') return;
  const dt = Math.min(0.05, dtMs / 1000);
  U.uTime.value += dt;
  const { route, physics, rider, chase } = world;
  if (state.mode === 'ride') {
    state.grade = route.gradient(state.s);
    const v = physics.step(dt, state.grade);
    state.speed = v;
    state.s = route.wrapS(state.s + v * dt);
    state.dist += v * dt;
    state.time += dt;
    state.elev = route.smoothY(state.s);
    const lean = placeRider(dt, v);
    world.audio?.update(dt, v, state.grade, rider.root.position.x, rider.root.position.z); // [audio hook]
    rider.update(dt, v, lean, Math.min(98, 62 + v * 2.6));
    chase.update(dt, rider.root.position, state.s, v);
    world.hud.update(dt, { speed: v, power: physics.P, dist: state.dist, grade: state.grade, elev: state.elev, time: state.time, s: state.s });
  } else if (state.mode === 'title') {
    titleT += dt;
    center.copy(rider.root.position);
    chase.orbitUpdate(dt, center, titleT);
    rider.update(dt, 0, 0, 0);
  } else if (state.mode === 'paused') {
    rider.update(dt, 0, state.lean, 0);
  }
  camera.updateMatrixWorld();
  if (world.weather) world.weather.update(dt, state.mode === 'paused', state.speed, !!(world.chase && world.chase.mode)); // WEATHER
  { const ps = state.mode === 'paused', rp = rider.root.position;
    if (world.traffic) world.traffic.update(dt, camera.position, rp, state.heading, state.speed, ps);
    if (world.people) world.people.update(dt, camera.position, rp, state.heading, state.speed, ps);
    if (world.birds) world.birds.update(dt, camera.position, rp, state.heading, state.speed, ps); }
  world.terrain.update(camera);
  world.trees.update(camera.position);
  world.street.update(camera.position);
  if ((frameNo++ & 7) === 0) {
    const k = world.chase && world.chase.mode ? 1.6 : 1;
    distanceCull(world.roads.mesh, camera.position, 2600 * cfg.lod * k);
    distanceCull(world.buildings.group, camera.position, (cfg.tier === 'low' ? 1000 : cfg.tier === 'medium' ? 2000 : 3500) * (cfg.tier === 'low' ? Math.min(k, 1.15) : k));
    if (world.walls) distanceCull(world.walls.mesh, camera.position, (cfg.tier === 'low' ? 700 : cfg.tier === 'medium' ? 1100 : 1700) * k);
  }
  if (world.grass) world.grass.update(camera, rider.root.position);
  world.sky.update(U.uTime.value, camera.position);
  U.uRiderPos.value.copy(rider.root.position);
  renderer.info.reset();
  post.composer.render(dt);
  if (dynres && state.mode !== 'title' && !NODYN) dynres.frame(dtMs);
}

canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); contextLost = true;
  if (state.mode === 'ride') state.mode = 'paused';
  fatal('Graphics paused', 'The GPU context was lost (often due to memory pressure or a backgrounded tab). Waiting for it to come back…');
}, false);
canvas.addEventListener('webglcontextrestored', () => {
  // three.js re-uploads resources lazily; rebuilding is the most reliable path
  $('glErrText').textContent = 'Graphics restored. Reload to continue the ride.';
}, false);

// testing hooks
window.__hb = { state, world, camera, renderer, breakdown() {
  const out = {}; const meas = () => { renderer.info.reset(); post.composer.render(0); return [renderer.info.render.calls, renderer.info.render.triangles]; };
  const all = meas(); out.all = all;
  for (const c of scene.children) { const v = c.visible; c.visible = false; const m = meas(); out[c.name || c.type] = [all[0] - m[0], all[1] - m[1]]; c.visible = v; }
  return out; }, getPost: () => post, setCamMode(m) { setCamMode(m); world.chase.initialized = false; }, setWeather(n, s) { setWeather(n, s == null ? 0 : s); }, getWeather, onWeatherEvent, get weather() { return world.weather; }, setS(s) { state.s = s; state.dist = s; state.time = s / 6.4; placeRider(0, 0); world.chase.initialized = false; }, cfg };

initWeatherUI(); // WEATHER: HUD button + title-screen chooser
requestAnimationFrame(frame);
build().catch((e) => { console.error(e); fatal('Could not build the world', String(e && e.message || e)); });
