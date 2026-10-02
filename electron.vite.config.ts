import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    base: './',
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Phase 5: standalone page proving the vendored-tesseract-asset
          // path (relative-to-document URLs) works both under the Vite dev
          // server and a built, offline, file:// load -- see
          // src/renderer/ocr-verify.html / src/renderer/src/ocr-verify.ts.
          ocrVerify: resolve(__dirname, 'src/renderer/ocr-verify.html'),
        },
      },
    },
  },
});
