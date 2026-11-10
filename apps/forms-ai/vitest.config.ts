import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // The window's page tests choose jsdom themselves (`@vitest-environment`).
    environment: 'node',
    // The end-to-end suite starts the server as a child process.
    testTimeout: 60_000,
  },
});
