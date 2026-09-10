import { integr8Config } from '@integr8/eslint-config';

export default [
  { ignores: ['dist/**', 'src-tauri/**'] },
  ...integr8Config(import.meta.dirname, { react: true }),
];
