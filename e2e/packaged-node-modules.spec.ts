// Phase 7 gate: the packaged --dir build's node_modules must contain
// better-sqlite3 and its native-addon runtime dependencies only -- none of
// the Vite/React/Tailwind/TypeScript/Playwright/tesseract.js toolchain
// (all consumed at build time, bundled into out/renderer/out/main by Vite,
// never required at runtime in the packaged app).
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const nodeModulesDir = path.join(repoRoot, 'dist', 'win-unpacked', 'resources', 'app', 'node_modules');

const FORBIDDEN = ['vite', 'react', 'react-dom', 'tailwindcss', '@tailwindcss', 'typescript', 'playwright', '@playwright', 'tesseract.js', 'tesseract.js-core', 'electron-vite', 'electron-builder', 'esbuild', 'vitest', 'jsdom'];

test('packaged node_modules contains only better-sqlite3 and its runtime deps', async () => {
  expect(fs.existsSync(nodeModulesDir), `expected ${nodeModulesDir} to exist -- run npm run dist or electron-builder --dir first`).toBe(true);

  const shipped = fs.readdirSync(nodeModulesDir);
  expect(shipped).toContain('better-sqlite3');

  const present = FORBIDDEN.filter(name => shipped.includes(name));
  expect(present, `forbidden build-time-only packages shipped in the packaged node_modules: ${present.join(', ')}`).toEqual([]);
});
