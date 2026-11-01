import { defineConfig } from 'vitest/config';

/**
 * jsdom, because the claim under test is about the DOM: that every widget is
 * labelled, reachable by keyboard and announced correctly. axe-core runs in the
 * same document. Colour contrast is not computed by jsdom; the design tokens
 * carry that, and P05 checked them.
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
