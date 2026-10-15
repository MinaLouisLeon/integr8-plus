import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every error code the API can return, read from its source (ADR-0012).
 *
 * The code is the contract between the API and the screens: the server's own
 * `message` is English written for a log, and a client shows the catalogue's
 * words for the code instead. So the list of codes is checked in beside the
 * catalogue (`packages/i18n/src/api-error-codes.ts`), a test there fails on a
 * code with no message in English or Arabic, and a test here fails when the
 * checked-in list no longer matches the source. Regenerate it with
 * `pnpm --filter @integr8/api error-codes`.
 *
 * How the codes are found — regular expressions over the source, deliberately
 * simple, with these limits:
 *
 * - **Helpers with a code argument.** `conflict('…'`, `unprocessable('…'`,
 *   `badRequest('…'`, the sync push's `rejected('…'`, `new ApiError(status,
 *   '…'` and `super(status, '…'` in an `ApiError` subclass. The helpers with a
 *   fixed code (`forbidden`, `notFound`, `unauthorised`, `tooManyRequests`,
 *   `internal`, `validationError`) are found by the same rule inside
 *   `http/errors.ts`, where each is a `new ApiError(status, '…'`.
 * - **A code that is not a string literal** is either a ternary of literals
 *   (all of them are taken) or one of the sites listed in {@link DYNAMIC_SITES},
 *   which says where its codes come from. Any other non-literal code fails the
 *   test, so a new one has to be added there rather than silently missed.
 * - **Details.** A `{ field, code }` object's `code` is shown to people as a
 *   line under the refusal, so it is collected too — except the codes in
 *   {@link DETAIL_CODES_NOT_SHOWN}, which carry data rather than a reason.
 * - **The phone's sync.** Every `code: '…'` in `sync/`, because a push result
 *   (rejected, conflict or retry) reaches the phone's outbox and is shown on
 *   its sync screen.
 * - **`@integr8/auth`.** Each error class's `readonly code = '…'`; the server
 *   passes those through as they are.
 *
 * Not collected: the per-row problems of a CSV import (`imports/run-import.ts`)
 * — those are rows of a report, not refusals of a request — and zod's issue
 * codes inside a `validation_failed`, which come from the library.
 * Comments are stripped before matching, so a code named in prose is not taken.
 */

const SOURCE_ROOT = resolve(import.meta.dirname, '..');
const AUTH_ERRORS = resolve(import.meta.dirname, '../../../../packages/auth/src/errors.ts');

/** The checked-in list, relative to this file (and to its compiled copy in `dist/testing`). */
export const CODE_LIST_PATH = resolve(
  import.meta.dirname,
  '../../../../packages/i18n/src/api-error-codes.ts',
);

/** Codes in `details[]` that are values, not reasons: the client version a 503 compares. */
const DETAIL_CODES_NOT_SHOWN = new Set(['minimum', 'unsupported']);

/**
 * Sites whose code is an expression rather than a literal, keyed by
 * `file|expression`, and where their codes really come from.
 */
const DYNAMIC_SITES: Record<string, (source: string) => readonly string[]> = {
  // The helpers' own definitions.
  'http/errors.ts|code': () => [],
  // A unique-constraint table: `constraint: ['code', 'body.field', 'message']`.
  'routes/v1/inventory.ts|code409': (source) =>
    [...source.matchAll(/\[\s*'([a-z][a-z0-9_]*)',\s*'body\./gu)].map(([, code]) => code ?? ''),
  'routes/v1/job-types.ts|`${field}_taken`': () => ['code_taken', 'name_taken'],
  // `assertStoredImage(tx, id, 'field', 'code', 'what')`.
  'routes/v1/settings.ts|code': (source) =>
    [
      ...source.matchAll(
        /assertStoredImage\(\s*[^,]+,\s*[^,]+,\s*'[^']*',\s*'([a-z][a-z0-9_]*)'/gu,
      ),
    ].map(([, code]) => code ?? ''),
  // `@integr8/auth`'s errors, passed through: read from that package below.
  'server.ts|error.code': () => [],
  // A shared helper's ApiError, turned into a push outcome: already collected.
  'sync/push.ts|error.code': () => [],
  // The assistant's quota refusal names its day or month code (docs/ai).
  // The token refusal does the same for tokens (ADR-0002 D5).
  'ai/errors.ts|code': () => [
    'ai_daily_quota_exceeded',
    'ai_monthly_quota_exceeded',
    'ai_daily_token_quota_exceeded',
    'ai_monthly_token_quota_exceeded',
  ],
  // `refuse('code', 'message', field)` for serial numbers and batches.
  'routes/v1/stock-lots.ts|code': (source) =>
    [...source.matchAll(/refuse\(\s*'([a-z][a-z0-9_]*)'/gu)].map(([, code]) => code ?? ''),
};

const CODE = /^[a-z][a-z0-9_.]*$/u;

export interface Extraction {
  /** Sorted, without duplicates. */
  codes: string[];
  /** `file|expression` for each non-literal code with no entry in {@link DYNAMIC_SITES}. */
  unresolved: string[];
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'testing' ? [] : sourceFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Removes block comments and whole-line `//` comments; a `//` inside a string stays. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
}

/** The first argument of a call, up to the first top-level comma or the closing bracket. */
function firstArgument(source: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) {
        return source.slice(from, index).trim();
      }
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      return source.slice(from, index).trim();
    }
  }
  return source.slice(from).trim();
}

/** The codes an argument names: a literal, or every literal in a ternary of them. */
function literalCodes(argument: string): string[] | undefined {
  const single = /^(['"])([^'"`]*)\1$/u.exec(argument);
  if (single !== null) {
    return CODE.test(single[2] ?? '') ? [single[2] ?? ''] : [];
  }
  if (!argument.includes('?')) {
    return undefined;
  }
  const literals = [...argument.matchAll(/'([a-z][a-z0-9_.]*)'/gu)].map(([, code]) => code ?? '');
  return literals.length > 0 ? literals : undefined;
}

export function extractErrorCodes(root = SOURCE_ROOT): Extraction {
  const codes = new Set<string>();
  const unresolved = new Set<string>();

  for (const file of sourceFiles(root)) {
    const name = relative(root, file).split('\\').join('/');
    const raw = readFileSync(file, 'utf8');
    const source = withoutComments(raw);

    const take = (argument: string) => {
      // A declaration such as `function rejected(code: string, …)`, not a call.
      if (/^[A-Za-z_]\w*\??\s*:/u.test(argument)) {
        return;
      }
      const literal = literalCodes(argument);
      if (literal !== undefined) {
        literal.forEach((code) => codes.add(code));
        return;
      }
      const key = `${name}|${argument.replace(/\s+/gu, ' ')}`;
      const dynamic = DYNAMIC_SITES[key];
      if (dynamic === undefined) {
        unresolved.add(key);
      } else {
        dynamic(source).forEach((code) => codes.add(code));
      }
    };

    // The code is the first argument.
    for (const match of source.matchAll(/\b(?:conflict|unprocessable|badRequest|rejected)\(/gu)) {
      take(firstArgument(source, (match.index ?? 0) + match[0].length));
    }
    // The code is the second argument, after the status.
    for (const match of source.matchAll(/(?:\bnew ApiError|\bsuper)\(\s*/gu)) {
      const start = (match.index ?? 0) + match[0].length;
      const status = firstArgument(source, start);
      if (match[0].startsWith('super') && !/^\d{3}$/u.test(status)) {
        continue;
      }
      const afterStatus = source.indexOf(',', start + status.length);
      if (afterStatus !== -1) {
        take(firstArgument(source, afterStatus + 1));
      }
    }
    // A detail a person sees under the refusal.
    for (const [, code] of source.matchAll(
      /\bfield:\s*(?:[^{}]|\$\{[^{}]*\})*?\bcode:\s*'([a-z][a-z0-9_.]*)'/gu,
    )) {
      if (code !== undefined && !DETAIL_CODES_NOT_SHOWN.has(code)) {
        codes.add(code);
      }
    }
    // A push outcome, which the phone shows on its sync screen.
    if (name.startsWith('sync/')) {
      for (const [, code] of source.matchAll(/\bcode:\s*'([a-z][a-z0-9_.]*)'/gu)) {
        if (code !== undefined && !DETAIL_CODES_NOT_SHOWN.has(code)) {
          codes.add(code);
        }
      }
    }
  }

  // `@integr8/auth`'s errors, which `server.ts` passes through with their code.
  for (const [, code] of withoutComments(readFileSync(AUTH_ERRORS, 'utf8')).matchAll(
    /readonly code = '([a-z][a-z0-9_.]*)'/gu,
  )) {
    if (code !== undefined) {
      codes.add(code);
    }
  }

  return { codes: [...codes].sort(), unresolved: [...unresolved].sort() };
}

/** The checked-in file's text: Prettier leaves it as it is. */
export function renderCodeList(codes: readonly string[]): string {
  return [
    '/**',
    ' * Every error code the API can return (ADR-0012): the contract between the',
    ' * API and the `apiErrors` messages in this package. A test here fails when a',
    ' * code has no message in English or Arabic.',
    ' *',
    ' * Generated from the API source — do not edit by hand. To update it, run',
    ' * `pnpm --filter @integr8/api error-codes`; how the codes are found is',
    ' * described in `apps/api/src/testing/error-codes.ts`.',
    ' */',
    'export const API_ERROR_CODES = [',
    ...codes.map((code) => `  '${code}',`),
    '] as const;',
    '',
    'export type ApiErrorCode = (typeof API_ERROR_CODES)[number];',
    '',
  ].join('\n');
}

/** The codes in a checked-in list, as written there. */
export function parseCodeList(text: string): string[] {
  const body = /API_ERROR_CODES = \[([\s\S]*?)\] as const/u.exec(text)?.[1] ?? '';
  return [...body.matchAll(/'([^']*)'/gu)].map(([, code]) => code ?? '');
}

export function readCodeList(path = CODE_LIST_PATH): string[] {
  return parseCodeList(readFileSync(path, 'utf8'));
}
