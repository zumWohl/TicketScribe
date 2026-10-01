#!/usr/bin/env node
// Vendors tesseract.js's worker/core assets plus eng.traineddata into
// src/renderer/public/vendor/tesseract/ (Vite serves/copies anything under a
// renderer's public/ as-is) so the packaged app never depends on a runtime
// CDN fetch for OCR to work (Phase 5). Output is gitignored; re-run via
// `npm run vendor:tesseract`, or automatically via postinstall / before
// `npm run build:vite` (prebuild:vite).
const fs = require('fs');
const path = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', 'src', 'renderer', 'public', 'vendor', 'tesseract');
// NOT the URL tesseract.js's own default langPath builds
// (https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0/eng.traineddata)
// -- confirmed 404 (verified eng@1.0.0 is the actual published npm version;
// "4.0.0" is a subdirectory inside it, not a package version, and the
// unversioned URL resolves to a path that was never real). The file that
// actually exists is the gzip-compressed one at the pinned version below.
// Saved locally WITHOUT the .gz extension: tesseract.js's loader fetches
// `${lang}.traineddata${gzip ? '.gz' : ''}` and only appends `.gz` when the
// caller explicitly passes `gzip: true` (not done here, matching the legacy
// call site) -- but it gunzips based on sniffing the magic bytes regardless
// of the gzip option or file extension, so this plain-named local file with
// gzip-compressed content loads correctly either way.
const TRAINEDDATA_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz';

function copyIfStale(src, destName) {
  const dest = path.join(OUT_DIR, destName);
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return;
  fs.copyFileSync(src, dest);
  console.log(`vendor-tesseract: copied ${destName}`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`download failed: ${url} -> ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(undefined)));
    }).on('error', err => { try { file.close(); } catch { /* ignore */ } reject(err); });
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  copyIfStale(require.resolve('tesseract.js/dist/worker.min.js'), 'worker.min.js');

  const coreDir = path.dirname(require.resolve('tesseract.js-core/tesseract-core.wasm.js'));
  const coreFiles = fs.readdirSync(coreDir).filter(f => /^tesseract-core.*\.(js|wasm)$/.test(f));
  for (const f of coreFiles) copyIfStale(path.join(coreDir, f), f);

  const trainedDataDest = path.join(OUT_DIR, 'eng.traineddata');
  if (!fs.existsSync(trainedDataDest)) {
    console.log('vendor-tesseract: downloading eng.traineddata (one-time, then cached locally)...');
    await download(TRAINEDDATA_URL, trainedDataDest);
    console.log('vendor-tesseract: downloaded eng.traineddata');
  }
}

main().catch(err => {
  console.error('vendor-tesseract: failed:', err.message);
  // Non-fatal at install time -- an environment without network access
  // shouldn't have `npm install` itself hard-fail. If eng.traineddata ends
  // up missing, `npm run test:ocr` will fail loudly and visibly instead,
  // which is the right place to surface it.
  process.exitCode = 0;
});
