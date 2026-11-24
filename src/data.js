// Data loading: all data is embedded in the bundle as gzip+base64 strings
// (see vite.config.js gz64 plugin) and decoded at startup. No network.
import meta from '@data/meta.json';
import heightB64 from '@data/height.bin?gz64';
import landcoverB64 from '@data/landcover.bin?gz64';
import featuresB64 from '@data/features.json?gz64';

function b64ToBytes(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser lacks DecompressionStream (needs Chrome 80+/Safari 16.4+).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadData(onProgress = () => {}) {
  onProgress(0.02, 'Decoding terrain');
  const hBytes = await gunzip(b64ToBytes(heightB64));
  const n = meta.cols * meta.rows;
  const raw = new Uint16Array(hBytes.buffer, hBytes.byteOffset, Math.min(n, hBytes.byteLength >> 1));
  const height = new Float32Array(n);
  const { hMin, hScale } = meta;
  for (let i = 0; i < raw.length; i++) height[i] = hMin + raw[i] * hScale;

  onProgress(0.05, 'Decoding land cover');
  const lcBytes = await gunzip(b64ToBytes(landcoverB64));
  const landcover = lcBytes.length >= n ? lcBytes.subarray(0, n) : (() => { const a = new Uint8Array(n); a.set(lcBytes); return a; })();

  onProgress(0.08, 'Decoding map features');
  const fBytes = await gunzip(b64ToBytes(featuresB64));
  const features = JSON.parse(new TextDecoder().decode(fBytes));
  for (const k of ['buildings', 'roads', 'rail', 'water', 'waterways', 'trees', 'walls']) {
    if (!Array.isArray(features[k])) features[k] = [];
  }
  return { meta, height, landcover, features };
}
