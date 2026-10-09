import { integr8Config } from '@integr8/eslint-config';

export default [
  { ignores: ['dist/**', 'src-tauri/**'] },
  ...integr8Config(import.meta.dirname, { react: true }),
  // Build scripts run in Node on the CI machine, not in the window.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
];
