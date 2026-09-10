import { integr8Config } from '@integr8/eslint-config';

/**
 * `src/generated` is written by `openapi-typescript` from `openapi.json` and
 * rewritten in full on every spec change. Linting it would report style
 * problems nobody can fix — any correction is discarded by the next
 * generation — so it is excluded here and from Prettier, and reviewed as a diff
 * against the previous generation instead.
 */
export default [{ ignores: ['src/generated/**'] }, ...integr8Config(import.meta.dirname)];
