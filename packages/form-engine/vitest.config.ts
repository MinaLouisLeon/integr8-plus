import { defineConfig } from 'vitest/config';

/**
 * Coverage is enforced here rather than reported. P06's exit criterion is 90
 * percent, and `pnpm test` in CI is `vitest run --coverage`, so dropping below it
 * fails the build.
 *
 * Branches are held to the same number as lines. On this package a branch is
 * usually a rule — "unanswered", "hidden", "out of range" — and an untested rule
 * is precisely the thing that disagrees between two runtimes.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The property suites run hundreds of generated forms each, and `pnpm test`
    // runs every package's suite at once on a two-core CI runner. Under that
    // load a run that takes three seconds alone has been seen to take twenty,
    // and a timeout there says nothing about the engine.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/test-support/**',
        'src/conformance/hermes-entry.ts',
      ],
      reporter: ['text-summary', 'text'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});
