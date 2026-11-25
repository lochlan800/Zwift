// Audio manager for Horbury Ride. The AudioContext is created only from a user gesture (start() is called
// in the Ride click handler), so browser autoplay rules are respected. Everything is procedural.
import { Soundscape } from './soundscape.js';
import { U } from '../world/shared.js';

const MUTE_KEY = 'horbury-ride-muted';
const SPEAKER = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z';
const MUTED = 'M4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.3l4.2 4.2c-.6.5-1.3.9-2.2 1.1v2.1c1.4-.3 2.6-.9 3.6-1.8L20.7 21 22 19.7 4.3 3z';

function readMuted() { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { return false; } }
function writeMuted(m) { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch (e) { /* private mode: ignore */ } }

export function createAudio() {
  let muted = readMuted();
  let ctx = null, sc = null, active = false;
  const inp = { speed: 0, grade: 0, rain: 0, storm: 0, wind: 0, cloud: 0, x: 0, z: 0 };

  // mute button: same look as the other HUD icon buttons, placed above the camera button (thumb reach)
  const btn = document.createElement('button');
  btn.id = 'muteBtn';
  btn.className = 'icon-btn';
  btn.setAttribute('aria-label', 'Mute sound');
  btn.style.top = 'auto';
  btn.style.bottom = 'calc(150px + var(--sab))';
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path class="ic"></path></svg>';
  const icon = btn.querySelector('path');
  const hud = document.getElementById('hud');
  if (hud) hud.appendChild(btn);

  function paintButton() {
    icon.setAttribute('d', muted ? MUTED : SPEAKER);
    btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
  }
  function setMuted(m) {
    muted = !!m; writeMuted(muted); paintButton();
    if (sc) sc.setMaster(muted ? 0 : 1);
  }
  btn.addEventListener('click', () => setMuted(!muted));
  paintButton();

  // called from the Ride click (user gesture): create or resume the AudioContext and build the graph once
  function start() {
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ctx = new AC();
        sc = new Soundscape(ctx, ctx.destination);
        sc.setMaster(muted ? 0 : 1);
      }
      active = true;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
    } catch (e) {
      console.warn('audio unavailable', e);
      active = false;
    }
  }

  // paused or tab hidden: suspend the context (no CPU, no sound); resumed by resume()
  function pause() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }
  function resume() { if (ctx && active && ctx.state !== 'running') ctx.resume().catch(() => {}); }

  // per-frame: rider speed/grade/position from main.js, weather from the shared uniforms
  function update(dt, speed, grade, x, z) {
    if (!sc || !active) return;
    inp.speed = speed; inp.grade = grade || 0; inp.x = x; inp.z = z;
    inp.rain = U.uRain ? U.uRain.value : 0;
    inp.storm = U.uStorm ? U.uStorm.value : 0;
    inp.cloud = U.uCloudCover ? U.uCloudCover.value : 0;
    inp.wind = U.uWind ? U.uWind.value.length() : 0;
    sc.update(dt, inp);
  }

  function lightning(distance) { if (sc) sc.lightning(distance); }

  // Adapter for the weather module: pass its API object ({ onWeatherEvent }) once it exists.
  // Lightning events are {distance} in metres.
  function bindWeather(api) {
    if (!api || typeof api.onWeatherEvent !== 'function') return;
    api.onWeatherEvent((e) => {
      if (e && (e.type === 'lightning' || e.name === 'lightning')) lightning(e.distance ?? 2000);
    });
  }

  // test hooks (used by the headless checks; harmless in the game)
  const api = { start, pause, resume, update, lightning, bindWeather, setMuted, isMuted: () => muted,
    debug: () => ({ state: ctx ? ctx.state : 'none', nodes: sc ? sc.levels() : null, muted, active }),
    getContext: () => ctx, renderOffline };
  window.__audio = api;
  return api;
}

// Offline render for tests: builds the same graph in an OfflineAudioContext and returns the AudioBuffer.
export async function renderOffline({ seconds = 4, sampleRate = 48000, inputs = {}, lightning = null, lightningAt = 0 }) {
  const off = new OfflineAudioContext(2, Math.floor(seconds * sampleRate), sampleRate);
  const sc = new Soundscape(off, off.destination);
  sc.setMaster(1);
  const s = Object.assign({ speed: 0, grade: 0, rain: 0, storm: 0, wind: 0, cloud: 0, x: 0, z: 0 }, inputs);
  sc.update(0.02, s);
  if (lightning !== null) sc.lightning(lightning, lightningAt);
  const buffer = await off.startRendering();
  return { buffer, levels: sc.levels() };
}
