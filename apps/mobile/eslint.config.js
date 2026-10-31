import { integr8Config, RTL_RESTRICTED_SYNTAX } from '@integr8/eslint-config';

/**
 * Expo writes `EXPO_PUBLIC_` values into the bundle only where the code says
 * `process.env.EXPO_PUBLIC_…` literally. A computed or destructured read is left
 * as it is, and a release build has nothing at that address when the app runs:
 * every phone build once talked to localhost because of one.
 */
const BUILD_SETTING_SYNTAX = [
  {
    selector:
      "MemberExpression[computed=true][object.type='MemberExpression'][object.object.name='process'][object.property.name='env']",
    message:
      'Read build settings as a literal process.env.EXPO_PUBLIC_… (see src/lib/env.ts): a computed read is empty in release builds.',
  },
  {
    selector:
      "VariableDeclarator[id.type='ObjectPattern'][init.type='MemberExpression'][init.object.name='process'][init.property.name='env']",
    message:
      'Read build settings as a literal process.env.EXPO_PUBLIC_… (see src/lib/env.ts): a destructured read is empty in release builds.',
  },
];

export default [
  { ignores: ['.expo/**', 'dist/**', 'expo-env.d.ts'] },
  ...integr8Config(import.meta.dirname, { react: true }),
  {
    // Every source file outside tests. The screen block below sets this rule
    // again for screens, so it carries these selectors too.
    files: ['app/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...RTL_RESTRICTED_SYNTAX, ...BUILD_SETTING_SYNTAX],
    },
  },
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
        ...BUILD_SETTING_SYNTAX,
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
