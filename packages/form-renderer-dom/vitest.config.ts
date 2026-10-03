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
  },
});
