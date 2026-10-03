import { integr8Config } from '@integr8/eslint-config';

/**
 * Root config, used when ESLint is invoked from the workspace root — notably by
 * lint-staged, which passes staged paths from every package at once.
 *
 * Per-package `eslint.config.js` files remain the source of truth for
 * `pnpm lint`. Both resolve the same rules; typescript-eslint's project service
 * locates each file's nearest tsconfig.json, so type-aware rules work either way.
 */
export default integr8Config(import.meta.dirname);
