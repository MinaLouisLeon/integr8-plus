import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Modules that speak to Postgres directly. Only `packages/db` may import these:
 * everywhere else, a query that bypasses the repository layer is a query with
 * no `tenant_id` filter, which is how one company reads another's data.
 *
 * P02 makes this a lint error rather than a code-review convention, because a
 * code-review convention is one distracted afternoon away from not existing.
 */
const RAW_DATABASE_MODULES = [
  {
    name: 'kysely',
    message:
      'Raw query access is confined to @integr8/db. Use a repository from @integr8/db, or add one there.',
  },
  {
    name: 'pg',
    message:
      'Raw query access is confined to @integr8/db. Use getTenantDataSource() from @integr8/db.',
  },
  {
    name: 'pg-pool',
    message: 'Raw query access is confined to @integr8/db.',
  },
  {
    name: 'postgres',
    message: 'Raw query access is confined to @integr8/db.',
  },
];

/**
 * Physical direction utilities and properties.
 *
 * Every one of these produces a layout that is wrong in Arabic, and each is
 * invisible until somebody switches the language — by which time there are
 * hundreds of screens. P05 puts the RTL work here rather than in P32 precisely
 * so that this rule exists before the first screen does.
 *
 * The logical equivalent is in the message, because "don't use ml-4" is only
 * half an instruction.
 */
const RTL_UNSAFE_CLASSES = [
  ['ml', 'ms'],
  ['mr', 'me'],
  ['pl', 'ps'],
  ['pr', 'pe'],
  ['left', 'start'],
  ['right', 'end'],
  ['border-l', 'border-s'],
  ['border-r', 'border-e'],
  ['rounded-l', 'rounded-s'],
  ['rounded-r', 'rounded-e'],
  ['text-left', 'text-start'],
  ['text-right', 'text-end'],
];

/**
 * Shared flat ESLint config for every package in the workspace.
 *
 * Consumers create an `eslint.config.js` containing:
 *
 *   import { integr8Config } from '@integr8/eslint-config';
 *   export default integr8Config(import.meta.dirname);
 *
 * `tsconfigRootDir` must be the consuming package's own directory so that
 * type-aware rules resolve against that package's tsconfig.
 *
 * @param {string} tsconfigRootDir Absolute path to the consuming package root.
 * @param {{ allowRawDatabaseAccess?: boolean, react?: boolean }} [options]
 *   `allowRawDatabaseAccess` lifts the ban on importing `kysely`/`pg`. Only
 *   `packages/db` sets it. `react` adds the hooks, accessibility and
 *   right-to-left rules; every package rendering an interface sets it.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function integr8Config(tsconfigRootDir, options = {}) {
  const { allowRawDatabaseAccess = false, react = false } = options;

  return tseslint.config(
    {
      ignores: [
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/.turbo/**',
        '**/node_modules/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    ...tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        // Unused variables are an error, but an underscore prefix marks intent.
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
          },
        ],
        // Type-only imports must be explicit so `verbatimModuleSyntax` is satisfied.
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-restricted-imports': allowRawDatabaseAccess
          ? 'off'
          : ['error', { paths: RAW_DATABASE_MODULES }],
      },
    },
    ...(react ? reactConfig() : []),
    {
      // Plain JavaScript in this workspace is tooling configuration, and config
      // files sit outside every tsconfig `include`. Neither can be type-checked,
      // so type-aware rules are switched off for them. All source is TypeScript.
      files: ['**/*.{js,mjs,cjs}', '**/*.config.ts'],
      ...tseslint.configs.disableTypeChecked,
    },
    prettier,
  );
}

/**
 * Rules for the packages that render an interface.
 *
 * Three concerns, all of which are cheap now and expensive later: hook
 * correctness, accessibility, and right-to-left safety.
 *
 * @returns {import('typescript-eslint').ConfigArray}
 */
function reactConfig() {
  return tseslint.config(
    {
      files: ['**/*.{ts,tsx}'],
      plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
      rules: {
        ...reactHooks.configs.recommended.rules,
        ...jsxA11y.flatConfigs.recommended.rules,

        // A missing dependency is a stale closure, which shows up as a screen
        // that quietly stops updating rather than as an error.
        'react-hooks/exhaustive-deps': 'error',

        // The rule that makes P05's RTL criterion enforceable rather than
        // aspirational.
        'no-restricted-syntax': [
          'error',
          // The class may be bare (`border-l`, `text-left`) or suffixed
          // (`ml-4`, `rounded-l-md`), and may sit anywhere in a space-separated
          // list. An earlier version of this pattern required a trailing
          // hyphen, which silently let `text-left` and `border-l` through — the
          // exact classes it existed to catch.
          //
          // `String.raw`, not an ordinary template literal: `\s` inside one is
          // just `s`, which silently turns the word-boundary guards into a
          // literal letter. That version matched a class at the start of a
          // string and nothing after it, so `className="flex ml-4"` passed.
          ...RTL_UNSAFE_CLASSES.map(([physical, logical]) => ({
            selector: String.raw`Literal[value=/(^|\s)-?${physical}(-[^\s]*)?(\s|$)/]`,
            message: `"${physical}" is a physical direction and mirrors wrongly in Arabic. Use "${logical}" instead.`,
          })),
          // React Native's equivalent. It does not accept `start` for text;
          // the direction-following value is `auto`, and `left`/`right` stay
          // put in a mirrored layout exactly as they do in CSS.
          {
            selector: "Property[key.name='textAlign'] > Literal[value='left']",
            message: "textAlign: 'left' does not mirror in Arabic. Use 'auto'.",
          },
          {
            selector: "Property[key.name='textAlign'] > Literal[value='right']",
            message: "textAlign: 'right' does not mirror in Arabic. Use 'auto'.",
          },
        ],
      },
    },
    {
      // Test files describe what a component does, and a test name may
      // legitimately contain "left" or "right".
      files: ['**/*.test.{ts,tsx}'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  );
}

export default integr8Config;
