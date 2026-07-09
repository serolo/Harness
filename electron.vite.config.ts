import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Three build targets: main (Node), preload (bridge), renderer (React).
// externalizeDepsPlugin keeps native/Node modules (better-sqlite3, node-pty, …)
// out of the main/preload bundles so they load from node_modules at runtime
// against the rebuilt Electron ABI (see `npm run rebuild`).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // A sandboxed preload (`sandbox: true`) is loaded by Electron as
        // CommonJS. Because package.json sets `"type": "module"`, a `.js`/`.mjs`
        // preload would be treated as ESM and fail with "Cannot use import
        // statement outside a module". Emit CJS with a `.cjs` extension so it is
        // unambiguously CommonJS regardless of the package type.
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
