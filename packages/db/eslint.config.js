import { integr8Config } from '@integr8/eslint-config';

/**
 * `packages/db` is the one place allowed to import `kysely` and `pg` directly.
 * Everywhere else the workspace config bans them; see `noRawDatabaseAccess` in
 * @integr8/eslint-config.
 */
export default integr8Config(import.meta.dirname, { allowRawDatabaseAccess: true });
