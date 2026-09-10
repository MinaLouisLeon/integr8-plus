import tailwind from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * One bundle, two homes.
 *
 * The same build is served as a browser page and loaded by the Tauri window.
 * P05's second exit criterion is that those two behave identically, and the way
 * to keep that true is to have one build rather than two — everything
 * Tauri-specific is behind a runtime check in `lib/platform.ts`, not behind a
 * build flag.
 */
export default defineConfig({
  plugins: [react(), tailwind()],

  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },

  server: {
    port: 3002,
    // Tauri loads the dev server through a fixed origin; failing loudly beats
    // silently moving to another port and showing a blank window.
    strictPort: true,
  },

  build: {
    // Source maps in production so a Sentry stack trace names real files.
    // Without them a report points at a line in a minified bundle.
    sourcemap: true,
    target: 'es2022',
  },
});
