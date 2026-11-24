import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

// Data directory: real data lives in src/data. HORBURY_DATA lets us point at a
// throwaway synthetic set while the real files are being produced.
const DATA_DIR = resolve(process.env.HORBURY_DATA || 'src/data');

// `import b64 from '@data/height.bin?gz64'` -> gzip-compressed, base64 string.
// Decoded at startup with DecompressionStream (no network requests).
function gz64Plugin() {
  return {
    name: 'gz64',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith('?gz64')) return null;
      const bare = id.slice(0, -5);
      const r = await this.resolve(bare, importer, { skipSelf: true });
      return r ? '\0gz64:' + r.id : null;
    },
    load(id) {
      if (!id.startsWith('\0gz64:')) return null;
      const file = id.slice(6);
      this.addWatchFile(file);
      const gz = gzipSync(readFileSync(file), { level: 9 });
      return `export default ${JSON.stringify(gz.toString('base64'))};`;
    },
  };
}

export default defineConfig({
  resolve: { alias: { '@data': DATA_DIR } },
  plugins: [gz64Plugin(), viteSingleFile()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 20000,
    assetsInlineLimit: 100000000,
    reportCompressedSize: false,
  },
  server: { host: true },
});
