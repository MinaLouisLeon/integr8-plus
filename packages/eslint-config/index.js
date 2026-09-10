import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

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
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function integr8Config(tsconfigRootDir) {
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
