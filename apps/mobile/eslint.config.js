import { integr8Config, RTL_RESTRICTED_SYNTAX } from '@integr8/eslint-config';

export default [
  { ignores: ['.expo/**', 'dist/**', 'expo-env.d.ts'] },
  ...integr8Config(import.meta.dirname, { react: true }),
  {
    // P11: screens read the phone's database and nothing else. Reaching for the
    // API from a screen is how a spinner ends up in front of data that was
    // already on the phone. Sync lives in `src/local`, and screens ask it to run
    // through `localData`, never by calling the client or the engine themselves.
    files: ['app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/forms/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@tanstack/react-query',
              message: 'Screens read the local database with useLocalQuery.',
            },
            {
              name: '@integr8/offline',
              importNames: ['SyncEngine', 'syncApiFor', 'pullChanges', 'uploadOne'],
              message: 'Screens record changes locally; ask localData.sync() to send them.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        // Setting this rule here replaces its options, so the shared
        // right-to-left selectors are carried over rather than lost.
        ...RTL_RESTRICTED_SYNTAX,
        {
          selector: "MemberExpression[object.callee.name='session'][property.name='client']",
          message: 'Screens never call the API. Read from the phone with useLocalQuery.',
        },
      ],
    },
  },
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
