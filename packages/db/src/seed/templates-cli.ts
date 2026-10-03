import { closeDatabase } from '../connection.js';
import { syncFormTemplates } from './templates.js';

/**
 * `pnpm --filter @integr8/db db:templates`
 *
 * Loads the global form template library. Safe to run in production and safe
 * to run repeatedly; see `syncFormTemplates`.
 */
syncFormTemplates()
  .then((count) => {
    console.log(`form templates synchronised: ${String(count)}`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
