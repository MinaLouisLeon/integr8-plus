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
  },
});
