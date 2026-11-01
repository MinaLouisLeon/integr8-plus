import { defineConfig } from 'vitest/config';

/**
 * jsdom, like the form renderer: the claims under test are about what a person
 * sees and can reach — access notes before anything else, only the transitions
 * they may make, every problem an import found — and axe-core checks the same
 * document.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/testing/setup.ts'],
    // A test may wait up to 5 s for an element (setup.ts), so the test itself needs
    // longer than vitest's default 5 s or a busy machine fails it at the edge.
    testTimeout: 20_000,
  },
});
