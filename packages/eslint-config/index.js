import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
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
 * @param {{ allowRawDatabaseAccess?: boolean }} [options]
 *   `allowRawDatabaseAccess` lifts the ban on importing `kysely`/`pg`. Only
 *   `packages/db` sets it.
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function integr8Config(tsconfigRootDir, options = {}) {
  const { allowRawDatabaseAccess = false } = options;

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

export default integr8Config;
