// Web Audio graph for the ride: rain, thunder, wind, tyres, freewheel ratchet and birdsong.
// Works with any BaseAudioContext (live or OfflineAudioContext for tests).
import { white, pink, brown, seamless, normalise, patter, rumble, crackle, ratchet } from './dsp.js';

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + (b - a) * Math.random();
const SEC = 6; // loop length for the noise beds

function makeBuffer(ctx, chans) {
  const len = chans[0].length, b = ctx.createBuffer(chans.length, len, ctx.sampleRate);
  chans.forEach((c, i) => b.getChannelData(i).set(c));
  return b;
}
function stereo(ctx, gen) { return makeBuffer(ctx, [gen(), gen()]); }

export class Soundscape {
  constructor(ctx, dest) {
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    this._last = new Map();
    this.birdTimer = 0.5;

    // one-off buffers, generated once
    const loop = (gen) => makeBuffer(ctx, [seamless(gen(), 2400), seamless(gen(), 2400)]);
    this.buf = {
      pink: loop(() => normalise(pink(sr * SEC + 2400), 0.7)),
      brown: loop(() => normalise(brown(sr * SEC + 2400), 0.7)),
      white: stereo(ctx, () => normalise(white(sr * 2), 0.6)),
      patterLight: makeBuffer(ctx, [patter(sr, SEC, 34, false), patter(sr, SEC, 34, false)]),
      patterHeavy: makeBuffer(ctx, [patter(sr, SEC, 46, true), patter(sr, SEC, 46, true)]),
      ratchet: makeBuffer(ctx, [ratchet(sr), ratchet(sr)]),
      crackle: [0, 1].map(() => makeBuffer(ctx, [crackle(sr, 0.7), crackle(sr, 0.7)])),
      rumble: [0, 1, 2].map(() => makeBuffer(ctx, [rumble(sr, 8), rumble(sr, 8)])),
    };

    // master: smooth mute, then a gentle limiter so stacked events never clip
    this.master = ctx.createGain();
    this.master.gain.value = 1;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10; comp.knee.value = 6; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.25;
    this.master.connect(comp).connect(dest);

    const bus = (name) => { const g = ctx.createGain(); g.connect(this.master); this[name] = g; return g; };
    bus('rainBus'); bus('windBus'); bus('bikeBus'); bus('birdBus'); bus('thunderBus');
    this.thunderBus.gain.value = 1;

    const src = (buffer, dst, rate = 1) => {
      const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.playbackRate.value = rate;
      s.connect(dst); s.start(0); return s;
    };
    const biq = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (v, dst) => { const g = ctx.createGain(); g.gain.value = v; g.connect(dst); return g; };

    // rain: soft bed in the 1-6 kHz band, light patter, heavy low thud and storm rumble
    const rainBed = biq('bandpass', 2600, 0.45);
    src(this.buf.pink, rainBed); rainBed.connect(this.gRainBed = gain(0, this.rainBus));
    src(this.buf.patterLight, this.gLight = gain(0, this.rainBus));
    const thud = biq('lowpass', 1100, 0.6);
    src(this.buf.patterHeavy, thud); thud.connect(this.gHeavy = gain(0, this.rainBus));
    const storm = biq('lowpass', 260, 0.6);
    src(this.buf.brown, storm); storm.connect(this.gStorm = gain(0, this.rainBus));

    // wind: band-passed noise, cutoff drifting slowly with an LFO
    this.bpWind = biq('bandpass', 700, 0.8);
    src(this.buf.pink, this.bpWind); this.bpWind.connect(this.gWind = gain(0, this.windBus));
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(this.bpWind.frequency); lfo.start(0);

    // tyres on tarmac: rolling band, plus a wet spray band
    this.bpTyre = biq('bandpass', 600, 0.7);
    src(this.buf.pink, this.bpTyre); this.bpTyre.connect(this.gTyre = gain(0, this.bikeBus));
    const spray = biq('bandpass', 3200, 0.9);
    src(this.buf.white, spray); spray.connect(this.gSpray = gain(0, this.bikeBus));

    // freehub ratchet while coasting
    this.ratchetSrc = src(this.buf.ratchet, this.gFree = gain(0, this.bikeBus), 1);

    this.gBirds = this.birdBus;
    this.update(0, { speed: 0, grade: 0, rain: 0, storm: 0, wind: 0, cloud: 0, x: 0, z: 0 });
  }

  // set an AudioParam towards a target, skipping tiny changes so automation stays cheap
  ramp(param, v, tau = 0.6) {
    const last = this._last.get(param);
    if (last !== undefined && Math.abs(last - v) < 0.002) return;
    this._last.set(param, v);
    param.setTargetAtTime(v, this.ctx.currentTime, tau);
  }

  setMaster(v) { this.ramp(this.master.gain, v, 0.08); }

  // inputs: speed (m/s), grade (fraction), rain/storm/cloud 0..1, wind (m/s), x/z position for rural-ness
  update(dt, s) {
    const rain = clamp(s.rain), storm = clamp(s.storm), cloud = clamp(s.cloud);
    const speed = Math.max(0, s.speed), grade = s.grade || 0;
    const windK = clamp(s.wind / 3);
    const wet = clamp(rain * 1.5 + storm);
    const sunny = (1 - rain) * (1 - 0.55 * cloud) * (1 - storm);
    const rural = clamp((Math.hypot(s.x + 100, s.z - 150) - 150) / 600);

    // rain and storm
    this.ramp(this.gRainBed.gain, 0.5 * rain * (1 + 0.6 * storm));
    this.ramp(this.gLight.gain, 0.45 * rain * (1 - 0.7 * storm));
    this.ramp(this.gHeavy.gain, 0.8 * storm);
    this.ramp(this.gStorm.gain, 0.6 * storm);

    // wind: louder with wind speed and with rider speed; rushing when descending fast
    const down = clamp((-grade - 0.02) / 0.06) * clamp(speed / 14);
    this.ramp(this.gWind.gain, (0.03 + 0.12 * windK) * clamp(0.3 + speed / 12, 0, 1.6) + 0.14 * down);
    this.ramp(this.bpWind.frequency, 500 + 300 * windK + speed * 30, 0.5);

    // tyres: roll noise rises with speed, hissier and brighter when wet
    const roll = clamp(speed / 22);
    this.ramp(this.gTyre.gain, 0.2 * roll * (1 + 0.5 * wet));
    this.ramp(this.bpTyre.frequency, 350 + speed * 30 + wet * 400, 0.5);
    this.ramp(this.gSpray.gain, 0.22 * wet * roll);

    // freewheel: when the rider is coasting downhill the ratchet buzzes, scaled to wheel speed
    const free = clamp((-grade - 0.025) / 0.03) * clamp(speed / 9);
    this.ramp(this.gFree.gain, 0.16 * free);
    this.ramp(this.ratchetSrc.playbackRate, Math.max(0.05, speed * 8.5 / 16), 0.2);

    // birdsong in the sun, more out in the countryside
    const birds = sunny * (0.2 + 0.8 * rural);
    this.ramp(this.birdBus.gain, 0.3 * birds);
    if (birds > 0.05) {
      this.birdTimer -= dt;
      if (this.birdTimer <= 0) {
        this.birdPhrase();
        this.birdTimer = rand(1.5, 6) / Math.max(0.3, birds);
      }
    }
  }

  // a short phrase of sine chirps with pitch sweeps
  birdPhrase() {
    const ctx = this.ctx, t0 = ctx.currentTime + 0.02;
    const n = 2 + Math.floor(rand(0, 4));
    const f0 = rand(2200, 4200);
    let t = t0;
    for (let i = 0; i < n; i++) {
      this.chirp(t, f0 * rand(0.92, 1.12), Math.random() < 0.5);
      t += rand(0.12, 0.3);
    }
  }

  chirp(t, f, up) {
    const ctx = this.ctx, dur = rand(0.05, 0.16), amp = rand(0.25, 0.5);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    const f1 = f * (up ? rand(1.25, 1.6) : rand(0.6, 0.8));
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    o.frequency.exponentialRampToValueAtTime(f * 0.95, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.birdBus);
    o.start(t); o.stop(t + dur + 0.03);
    o.onended = () => { o.disconnect(); g.disconnect(); };
  }

  // a lightning strike at `distance` metres. The flash crackle is immediate; the thunder arrives after distance / 343 s.
  lightning(distance, at) {
    const ctx = this.ctx, t = at ?? ctx.currentTime;
    const d = Math.max(0, distance);
    const near = clamp(1 - d / 4000);
    // electric crackle at the flash, brighter and louder when close
    const c = ctx.createBufferSource();
    c.buffer = this.buf.crackle[Math.random() < 0.5 ? 0 : 1];
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900 + near * 1500;
    const cg = ctx.createGain(); cg.gain.value = 0.15 + 0.5 * near;
    c.connect(hp).connect(cg).connect(this.thunderBus);
    c.start(t); c.stop(t + 0.75);
    // rolling rumble, delayed by sound travel time; louder and sharper when near
    const delay = d / 343, t0 = t + delay;
    const dur = Math.min(7.5, rand(3, 6) * (1 + d / 4000));
    const r = ctx.createBufferSource();
    r.buffer = this.buf.rumble[Math.floor(rand(0, 3))];
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90 + near * 170; lp.Q.value = 0.5;
    const rg = ctx.createGain();
    const peak = 0.15 + 0.65 * near;
    rg.gain.setValueAtTime(0.0001, t0);
    rg.gain.exponentialRampToValueAtTime(peak, t0 + 0.08);
    rg.gain.setValueAtTime(peak, t0 + 0.08 + 0.3 * dur * 0.2);
    rg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    r.connect(lp).connect(rg).connect(this.thunderBus);
    r.start(t0); r.stop(t0 + dur + 0.05);
    return { delay, dur, peak };
  }

  // readable gain values for debugging and tests
  levels() {
    const out = {};
    const read = (k, p) => { out[k] = +(p.value).toFixed(4); };
    read('rainBed', this.gRainBed.gain); read('rainLight', this.gLight.gain); read('rainHeavy', this.gHeavy.gain);
    read('storm', this.gStorm.gain); read('wind', this.gWind.gain); read('tyre', this.gTyre.gain);
    read('spray', this.gSpray.gain); read('freewheel', this.gFree.gain); read('birds', this.birdBus.gain);
    read('master', this.master.gain);
    return out;
  }
}
