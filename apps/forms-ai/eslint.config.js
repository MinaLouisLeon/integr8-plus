import { integr8Config } from '@integr8/eslint-config';

// The preview window's page (src/window/page) renders an interface, so it gets
// the hooks, accessibility and right-to-left rules. The right-to-left rule reads
// every string, and the rest of the program writes guides for an AI ("left",
// "right" in prose), so it stays on the page only.
export default [
  ...integr8Config(import.meta.dirname, { react: true }),
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    ignores: ['src/window/page/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
