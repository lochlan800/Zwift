// Procedural sample generators for the Horbury Ride soundscape. Everything is synthesised in code
// (no audio files). Buffers are generated once and looped or re-triggered by the graph.

const rnd = Math.random;

export function white(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = rnd() * 2 - 1;
  return a;
}

// Paul Kellet's pink-noise filter
export function pink(n) {
  const a = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return a;
}

// leaky-integrated white noise (brown / red noise): low and rumbly
export function brown(n) {
  const a = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02;
    a[i] = last * 3.5;
  }
  return a;
}

// Make an array loop without a seam: crossfade the last f samples into the first f and drop the tail.
export function seamless(a, f) {
  const n = a.length, L = n - f, out = new Float32Array(L);
  out.set(a.subarray(0, L));
  for (let i = 0; i < f; i++) {
    const w = i / f;
    out[i] = a[n - f + i] * (1 - w) + a[i] * w;
  }
  return out;
}

export function normalise(a, peak) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  if (m > 0) { const g = peak / m; for (let i = 0; i < a.length; i++) a[i] *= g; }
  return a;
}

// one raindrop: short decaying sine "tick" (light) or low "thud" (heavy)
function addDrop(a, i0, sr, heavy) {
  const f = heavy ? 160 + rnd() * 300 : 1400 + rnd() * 3000;
  const tau = heavy ? 0.028 : 0.005 + rnd() * 0.01;
  const amp = (heavy ? 0.6 : 0.25) * (0.4 + rnd() * 0.6) * (rnd() < 0.08 ? 1.7 : 1);
  const len = Math.min(a.length - i0, Math.floor(sr * tau * 7));
  const w = 2 * Math.PI * f / sr;
  for (let j = 0; j < len; j++) {
    const env = Math.exp(-j / (sr * tau)) * (j < sr * 0.0008 ? j / (sr * 0.0008) : 1);
    a[i0 + j] += amp * env * Math.sin(w * j);
  }
}

// Randomised raindrop patter: Poisson arrivals at `rate` drops/second over `sec` seconds.
export function patter(sr, sec, rate, heavy) {
  const n = Math.floor(sr * sec), a = new Float32Array(n);
  const per = 1 / rate;
  let t = -Math.log(1 - rnd()) * per;
  while (t * sr < n) {
    addDrop(a, Math.floor(t * sr), sr, heavy);
    t += -Math.log(1 - rnd()) * per;
  }
  return a;
}

// Deep rolling thunder: brown noise with slow random amplitude modulation (a one-shot of `sec` seconds)
export function rumble(sr, sec) {
  const n = Math.floor(sr * sec), a = brown(n);
  const lfo = [0, 0, 0].map(() => ({ f: 0.12 + rnd() * 0.5, p: rnd() * 6.283, d: 0.2 + rnd() * 0.25 }));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let am = 1;
    for (const l of lfo) am += l.d * Math.sin(6.283 * l.f * t + l.p);
    // slight crack in the first half second, then the roll
    const crack = t < 0.5 ? 1 + 0.6 * Math.exp(-t * 6) : 1;
    a[i] *= Math.max(0, am) * crack;
  }
  return normalise(a, 0.9);
}

// Electric crackle / zap: a sharp first burst plus scattered micro-discharges, brightened by differencing
export function crackle(sr, sec) {
  const n = Math.floor(sr * sec), a = new Float32Array(n);
  const burst = (t0, tau, amp) => {
    const i0 = Math.floor(t0 * sr), len = Math.min(n - i0, Math.floor(sr * tau * 6));
    for (let j = 0; j < len; j++) a[i0 + j] += amp * (rnd() * 2 - 1) * Math.exp(-j / (sr * tau));
  };
  burst(0, 0.035, 1);
  burst(0.002, 0.012, 0.8);
  for (let k = 0; k < 14; k++) burst(rnd() * sec * 0.6, 0.002 + rnd() * 0.01, 0.2 + rnd() * 0.6);
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = a[i] - 0.6 * a[i - 1];
  return normalise(d, 0.95);
}

// Freehub ratchet buzz: `clicks` evenly spaced short clicks in a one-second loop
export function ratchet(sr, clicks = 16) {
  const n = sr, a = new Float32Array(n);
  for (let k = 0; k < clicks; k++) {
    const i0 = Math.floor((k / clicks) * n), len = Math.floor(sr * 0.004);
    for (let j = 0; j < len && i0 + j < n; j++) a[i0 + j] += (rnd() * 2 - 1) * Math.exp(-j / (sr * 0.0009));
  }
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = a[i] - a[i - 1];
  return normalise(d, 0.9);
}
