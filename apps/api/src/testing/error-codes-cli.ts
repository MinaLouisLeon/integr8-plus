import { writeFileSync } from 'node:fs';
import { CODE_LIST_PATH, extractErrorCodes, renderCodeList } from './error-codes.js';

/**
 * Writes the checked-in list of the API's error codes
 * (`packages/i18n/src/api-error-codes.ts`). Run it with
 * `pnpm --filter @integr8/api error-codes` after adding or removing a code,
 * then give any new code a message in `en.ts` and `ar.ts` under `apiErrors`.
 */
const { codes, unresolved } = extractErrorCodes();

if (unresolved.length > 0) {
  console.error(
    [
      'These error codes are expressions, not string literals, and the extractor does not know',
      'where they come from. Add each to DYNAMIC_SITES in apps/api/src/testing/error-codes.ts:',
      ...unresolved.map((site) => `  ${site}`),
    ].join('\n'),
  );
  process.exit(1);
}

writeFileSync(CODE_LIST_PATH, renderCodeList(codes));
console.log(`Wrote ${String(codes.length)} error codes to ${CODE_LIST_PATH}`);
