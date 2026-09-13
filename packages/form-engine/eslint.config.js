import { integr8Config } from '@integr8/eslint-config';

/**
 * The form engine has to produce the same answer on a server, in a browser and
 * on a phone. Everything below is a way to lose that, made a lint error.
 *
 * - **Platform imports.** React, React Native, a database client or a Node
 *   built-in each pin the package to one runtime.
 * - **`Date`, `Intl`, `toLocale*`, `localeCompare`.** Their output depends on the
 *   host's clock, time zone, locale data and ICU version. Hermes ships without
 *   `Intl` in some builds entirely. Dates are parsed by hand in `temporal.ts`,
 *   and "today" is an input, never a lookup.
 * - **`Math.random` and floating-point formatting.** Nondeterministic, or
 *   formatted differently between engines for the same double.
 * - **`eval` and `new Function`.** The plan says never, and it is a form
 *   definition written by a customer that would be evaluated.
 *
 * Tests and scripts run in Node on purpose and are exempt.
 */
const ENGINE_FILES = ['src/**/*.ts'];
const EXEMPT = ['src/**/*.test.ts', 'src/test-support/**'];

export default [
  ...integr8Config(import.meta.dirname),
  {
    files: ENGINE_FILES,
    ignores: EXEMPT,
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^node:', message: 'The form engine runs on phones. No Node built-ins.' },
            {
              regex: '^(react|react-native|react-dom)(/|$)',
              message: 'The form engine has no UI. Renderers import it, not the other way round.',
            },
            {
              regex: '^(@integr8/db|@integr8/api-client|kysely|pg|expo.*)(/|$)',
              message: 'The form engine is pure. Persistence and transport live elsewhere.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message:
            'Clocks and time zones differ by host. Use temporal.ts, and take "today" as input.',
        },
        {
          name: 'Intl',
          message: 'Locale data differs by engine, and is absent from some Hermes builds.',
        },
        { name: 'eval', message: 'Never evaluate a customer-authored definition as code.' },
        { name: 'Function', message: 'Never evaluate a customer-authored definition as code.' },
        { name: 'process', message: 'The form engine runs on phones.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Results must be reproducible.' },
        { property: 'localeCompare', message: 'Locale-dependent. Compare code units.' },
        { property: 'toLocaleString', message: 'Locale-dependent.' },
        { property: 'toLocaleDateString', message: 'Locale-dependent.' },
        { property: 'toFixed', message: 'Formats doubles; use decimal.ts.' },
        { property: 'toPrecision', message: 'Formats doubles; use decimal.ts.' },
      ],
      'no-new-func': 'error',
      'no-eval': 'error',
    },
  },
];
