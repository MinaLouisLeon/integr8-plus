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
        'form-engine',
        'form-renderer',
        'form-input',
        'forms-ai',
        'operations',
        'crm',
        'erp',
        'offline',
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
