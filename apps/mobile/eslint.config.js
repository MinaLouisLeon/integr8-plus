import { integr8Config } from '@integr8/eslint-config';

export default [
  { ignores: ['.expo/**', 'dist/**', 'expo-env.d.ts'] },
  ...integr8Config(import.meta.dirname, { react: true }),
  {
    // Metro's config has to be CommonJS — Expo loads it with `require` before
    // any ESM loader exists — so the module-system rules do not apply to it.
    files: ['metro.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
];
