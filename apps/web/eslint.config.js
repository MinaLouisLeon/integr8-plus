import { integr8Config } from '@integr8/eslint-config';

export default [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...integr8Config(import.meta.dirname, { react: true }),
];
