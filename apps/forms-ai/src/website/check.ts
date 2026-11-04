import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import {
  DEFAULT_DOCUMENT_ROUTE,
  ENV_API_URL,
  ENV_WEBSITE_KEY,
  KNOWN_WEBSITE_PATHS,
  WEBSITE_KEY_IN_TEXT,
} from './contract.js';

/**
 * `check_website_integration`: reads a company website's files and reports
 * the mistakes that would leak the website key or break the shared PDF
 * search. Read-only and offline, like every tool here: it opens only the
 * paths the AI passes and never calls the API.
 *
 * The checks are text patterns, not a compiler: they catch the usual slips
 * (a key in browser code, a `NEXT_PUBLIC_` name, an invented endpoint) and
 * say where. A clean result is not a security review.
 */

export interface WebsiteFinding {
  code: string;
  file: string;
  line: number;
  message: string;
}

export interface WebsiteCheck {
  ok: boolean;
  scanned: number;
  skipped: string[];
  problems: WebsiteFinding[];
  warnings: WebsiteFinding[];
}

const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.vercel',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
]);
const MAX_FILES = 5000;
const MAX_BYTES = 1024 * 1024;

const isEnvFile = (name: string) => name === '.env' || name.startsWith('.env.');
/** Env files meant to stay on one machine (Next.js ignores them in git by default). */
const isLocalEnv = (name: string) => name === '.env.local' || /^\.env\.[a-z]+\.local$/u.test(name);
const isExampleEnv = (name: string) => /^\.env\.(example|sample|template|dist)$/u.test(name);

const directive = (source: string, word: 'use client' | 'use server') =>
  new RegExp(`^(?:\\s|//[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*(['"])${word}\\1`, 'u').test(source);

function collect(paths: readonly string[], skipped: string[]): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    if (files.length >= MAX_FILES) {
      return;
    }
    const stats = statSync(path);
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(basename(path))) {
        return;
      }
      for (const entry of readdirSync(path).sort()) {
        visit(join(path, entry));
      }
      return;
    }
    const name = basename(path);
    if (!SOURCE.has(extname(name)) && !isEnvFile(name)) {
      return;
    }
    if (stats.size > MAX_BYTES) {
      skipped.push(`${path} (over 1 MB)`);
      return;
    }
    files.push(path);
  };
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new Error(
        `"${path}" is not an absolute path. Pass absolute paths of files or folders.`,
      );
    }
    if (!existsSync(path)) {
      throw new Error(`"${path}" does not exist.`);
    }
    visit(path);
  }
  if (files.length >= MAX_FILES) {
    skipped.push(`everything after ${String(MAX_FILES)} files: pass a narrower folder`);
  }
  return files;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let at = 0; at < index; at += 1) {
    if (source.charCodeAt(at) === 10) {
      line += 1;
    }
  }
  return line;
}

/** Every match of a global pattern, with its line. */
function matches(source: string, pattern: RegExp): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  for (const match of source.matchAll(pattern)) {
    found.push({ text: match[0], line: lineOf(source, match.index) });
  }
  return found;
}

const readsKey = new RegExp(
  `(?:process\\.env|env)(?:\\.${ENV_WEBSITE_KEY}\\b|\\[\\s*['"]${ENV_WEBSITE_KEY}['"]\\s*\\])`,
  'gu',
);

export function checkWebsite(paths: readonly string[]): WebsiteCheck {
  const skipped: string[] = [];
  const files = collect(paths, skipped);
  const roots = paths.filter((path) => statSync(path).isDirectory());
  const problems: WebsiteFinding[] = [];
  const warnings: WebsiteFinding[] = [];
  const shown = (file: string) => {
    const root = roots.find((folder) => file.startsWith(folder + sep) || file === folder);
    return root === undefined ? file : relative(root, file).split(sep).join('/');
  };
  const problem = (code: string, file: string, line: number, message: string) =>
    problems.push({ code, file: shown(file), line, message });
  const warning = (code: string, file: string, line: number, message: string) =>
    warnings.push({ code, file: shown(file), line, message });

  let callsLookup = false;
  let callsByCode = false;
  let readsApiUrl = false;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const name = basename(file);

    for (const hit of matches(
      source,
      /NEXT_PUBLIC_[A-Z0-9_]*(?:INTEGR8|WEBSITE_KEY)[A-Z0-9_]*/gu,
    )) {
      problem(
        'public_env_name',
        file,
        hit.line,
        `${hit.text}: a NEXT_PUBLIC_ variable is built into the pages every visitor downloads. Name it ${hit.text.includes('KEY') ? ENV_WEBSITE_KEY : ENV_API_URL} and read it only on the server.`,
      );
    }

    if (isEnvFile(name)) {
      const key = matches(source, new RegExp(WEBSITE_KEY_IN_TEXT.source, 'gu'))[0];
      if (key !== undefined) {
        if (isExampleEnv(name)) {
          problem(
            'key_in_example_env',
            file,
            key.line,
            `A real website key is in ${name}, which is committed. Remove it here (leave ${ENV_WEBSITE_KEY}= empty) and ask Integr8 to replace the key.`,
          );
        } else if (!isLocalEnv(name)) {
          warning(
            'key_in_shared_env',
            file,
            key.line,
            `${name} is often committed. Keep the key in .env.local and in Vercel's Environment Variables only.`,
          );
        }
      }
      continue;
    }

    for (const hit of matches(source, new RegExp(WEBSITE_KEY_IN_TEXT.source, 'gu'))) {
      problem(
        'key_in_code',
        file,
        hit.line,
        `A website key is written in the code. Read it from process.env.${ENV_WEBSITE_KEY} instead, and ask Integr8 to replace this key: it has been exposed.`,
      );
    }

    const client = directive(source, 'use client');
    const server = directive(source, 'use server') || /import\s+['"]server-only['"]/u.test(source);
    const keyReads = matches(source, readsKey);
    const websiteCalls = matches(source, /\/v1\/website\/[^'"`\s?#)]*/gu);

    if (new RegExp(`\\b${ENV_API_URL}\\b`, 'u').test(source)) {
      readsApiUrl = true;
    }

    if (client) {
      for (const hit of [...keyReads, ...websiteCalls]) {
        problem(
          'browser_code',
          file,
          hit.line,
          `This file is browser code ('use client'), and ${hit.text.startsWith('/v1') ? 'calls Integr8 from the browser' : 'reads the website key'}. Call Integr8 only from a Server Action, Route Handler or a module with import 'server-only'.`,
        );
      }
      for (const hit of matches(
        source,
        /\b(?:website_key_invalid|feature_disabled|rate_limited|validation_failed)\b/gu,
      )) {
        warning(
          'refusal_shown',
          file,
          hit.line,
          `The page tells visitors why Integr8 refused (${hit.text}). Show the same "not found" for every failure; log the reason on the server.`,
        );
      }
    } else if (keyReads.length > 0 && !server && !isServerFile(file)) {
      warning(
        'not_marked_server_only',
        file,
        keyReads[0]!.line,
        `This file reads the website key but is not marked server-only. Add import 'server-only' at the top so the build fails if browser code ever imports it.`,
      );
    }

    // The document page every shared link opens (0075): a page in a `[code]`
    // folder. Not for search engines, like the search page.
    if (/\/\[code\]\/page\.[cm]?[jt]sx?$/u.test(file.split(sep).join('/'))) {
      if (!/index\s*:\s*false/u.test(source)) {
        warning(
          'page_indexed',
          file,
          1,
          'The document page is not marked noindex. Add `robots: { index: false }` to its metadata so search engines never list a shared document.',
        );
      }
    }

    for (const hit of websiteCalls) {
      const path = hit.text.endsWith('/') ? `${hit.text}x` : hit.text;
      const normal = path.replace(/\$\{[^}]*\}/gu, 'x').replace(/\{[^}]*\}/gu, 'x');
      if (!KNOWN_WEBSITE_PATHS.some((known) => known.test(normal))) {
        problem(
          'unknown_endpoint',
          file,
          hit.line,
          `${hit.text} is not an Integr8 endpoint. There is no list of documents: search with POST /v1/website/documents/lookup and { q }, or open one with GET /v1/website/documents/by-code/{code} (see get_website_api).`,
        );
      }
      if (hit.text.startsWith('/v1/website/documents/by-code')) {
        callsByCode = true;
      }
      if (hit.text.startsWith('/v1/website/documents/lookup')) {
        callsLookup = true;
        if (!/method\s*:\s*['"]POST['"]/iu.test(source)) {
          warning(
            'lookup_not_post',
            file,
            hit.line,
            "The lookup is POST with a JSON body ({ q }); this file does not say method: 'POST'.",
          );
        }
        if (/\{\s*reference\b/u.test(source) && !/\{\s*q\b/u.test(source)) {
          warning(
            'old_lookup_body',
            file,
            hit.line,
            'This sends the older { reference, customer } body, which searches the reference only and asks for the customer name. Send { q } (one search box): it searches every field the company made searchable, and returns every match in `documents`.',
          );
        }
      }
    }

    if (
      websiteCalls.length > 0 &&
      !/no-store|revalidate\s*[:=]\s*0\b|force-dynamic/u.test(source)
    ) {
      warning(
        'may_be_cached',
        file,
        websiteCalls[0]!.line,
        "Add cache: 'no-store' to the fetch: Integr8's answers carry five-minute links and must never be cached.",
      );
    }

    if (
      /\b(?:viewUrl|downloadUrl)\b/u.test(source) &&
      /\b(?:localStorage|sessionStorage|unstable_cache|cookies\(\)\.set|revalidate\s*:\s*[1-9])/u.test(
        source,
      )
    ) {
      const at = matches(
        source,
        /\b(?:localStorage|sessionStorage|unstable_cache|cookies\(\)\.set|revalidate\s*:\s*[1-9])/gu,
      )[0]!;
      warning(
        'links_kept',
        file,
        at.line,
        'viewUrl and downloadUrl stop working after five minutes: hand them to the visitor at once, never store or cache them. Store the stable `link` if anything.',
      );
    }

    for (const hit of matches(source, /console\.(?:log|info|warn|error|debug)\([^\n]*/gu)) {
      // The key's value read into a log line, or the request's headers; naming
      // the variable in a message ("… is not set") is fine.
      if (
        new RegExp(readsKey.source, 'u').test(hit.text) ||
        /Bearer\s*\$\{|['"`]Bearer ['"`]\s*\+|\bheaders\b|\bauthorization\b/u.test(hit.text)
      ) {
        problem(
          'key_logged',
          file,
          hit.line,
          'This log line may print the website key. Log the status and the error code only.',
        );
      }
    }

    for (const hit of matches(source, /(?:Response\.json|NextResponse\.json)\([^\n]*/gu)) {
      if (new RegExp(readsKey.source, 'u').test(hit.text)) {
        problem(
          'key_in_response',
          file,
          hit.line,
          'This response sends the website key to the browser. Never return it.',
        );
      }
    }
  }

  if (files.length > 0 && !callsLookup) {
    warnings.push({
      code: 'no_lookup',
      file: '',
      line: 0,
      message:
        'None of these files calls POST /v1/website/documents/lookup. Pass the folder that holds the search page, or add it (get_website_example).',
    });
  } else if (callsLookup && !readsApiUrl) {
    warnings.push({
      code: 'api_url_not_from_env',
      file: '',
      line: 0,
      message: `The API address is not read from ${ENV_API_URL}. Keep it in the environment so a test server can be used.`,
    });
  }

  if (files.length > 0 && !callsByCode) {
    warnings.push({
      code: 'no_document_page',
      file: '',
      line: 0,
      message: `None of these files calls GET /v1/website/documents/by-code/{code}. When Integr8 points the company's document links at its website, shared links and new QR codes open /${DEFAULT_DOCUMENT_ROUTE}/<code> (or the address Integr8 set): add that page (get_website_example), or they will land on a 404.`,
    });
  }

  for (const root of roots) {
    const ignore = join(root, '.gitignore');
    if (existsSync(ignore) && !/^\s*\.env/mu.test(readFileSync(ignore, 'utf8'))) {
      warnings.push({
        code: 'env_not_ignored',
        file: '.gitignore',
        line: 0,
        message:
          '.gitignore does not ignore .env files. Add `.env*.local` (and `.env` if it holds secrets) so the key is never committed.',
      });
    }
  }

  return { ok: problems.length === 0, scanned: files.length, skipped, problems, warnings };
}

/** Next.js files that only ever run on the server. */
function isServerFile(file: string): boolean {
  const path = file.split(sep).join('/');
  return (
    /\/route\.[cm]?[jt]sx?$/u.test(path) ||
    /\/middleware\.[cm]?[jt]s$/u.test(path) ||
    path.includes('/pages/api/') ||
    /\.server\.[cm]?[jt]sx?$/u.test(path)
  );
}

function line(finding: WebsiteFinding, index: number): string {
  const where =
    finding.file === ''
      ? ''
      : `${finding.file}${finding.line > 0 ? `:${String(finding.line)}` : ''} `;
  return `${String(index + 1)}. ${where}[${finding.code}] ${finding.message}`;
}

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

export function formatWebsiteCheck(check: WebsiteCheck): string {
  const verdict = check.ok
    ? `OK: no leak or broken call found in ${plural(check.scanned, 'file')}.`
    : `NOT OK: ${plural(check.problems.length, 'problem')} in ${plural(check.scanned, 'file')}. Fix them and check again.`;
  const parts = [`${verdict} ${plural(check.warnings.length, 'warning')}.`];
  if (check.problems.length > 0) {
    parts.push(`\nProblems (must fix):\n${check.problems.map(line).join('\n')}`);
  }
  if (check.warnings.length > 0) {
    parts.push(`\nWarnings (should fix):\n${check.warnings.map(line).join('\n')}`);
  }
  if (check.skipped.length > 0) {
    parts.push(`\nNot read: ${check.skipped.join('; ')}`);
  }
  parts.push(
    '\nThese are pattern checks, not a security review: still run the site and try a shared document and a wrong number.',
  );
  parts.push(
    `\nAs JSON:\n${JSON.stringify({ ok: check.ok, problems: check.problems, warnings: check.warnings })}`,
  );
  return parts.join('\n');
}
