/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'api',
        'web',
        'desktop',
        'mobile',
        'core',
        'db',
        'auth',
        'config',
        'ci',
        'deps',
        'plan',
        'repo',
      ],
    ],
    'header-max-length': [2, 'always', 100],
  },
};
