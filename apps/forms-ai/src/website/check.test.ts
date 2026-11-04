import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkWebsite, formatWebsiteCheck } from './check.js';

const root = mkdtempSync(join(tmpdir(), 'forms-ai-check-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const KEY = `i8wk_${'Z'.repeat(43)}`;
let count = 0;

/** A website folder with these files, checked. */
function site(files: Record<string, string>) {
  const folder = join(root, `site-${String((count += 1))}`);
  for (const [path, content] of Object.entries(files)) {
    const target = join(folder, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return checkWebsite([folder]);
}

const codes = (findings: { code: string }[]) => findings.map((finding) => finding.code).sort();

const GOOD_ACTION = `'use server';
export async function find(q: string) {
  const response = await fetch(process.env.INTEGR8_API_URL + '/v1/website/documents/lookup', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.INTEGR8_WEBSITE_KEY },
    body: JSON.stringify({ q }),
    cache: 'no-store',
  });
  return response.json();
}
`;

/** The document page shared links open (0075), done right. */
const GOOD_DOCUMENT = `import 'server-only';
export const metadata = { robots: { index: false } };
export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const answer = await fetch(process.env.INTEGR8_API_URL + '/v1/website/documents/by-code/' + code, {
    headers: { authorization: 'Bearer ' + process.env.INTEGR8_WEBSITE_KEY },
    cache: 'no-store',
  });
  return answer.ok ? 'found' : 'not found';
}
`;

describe('check_website_integration', () => {
  it('passes a correct Server Action', () => {
    const check = site({
      'app/find/actions.ts': GOOD_ACTION,
      'app/documents/[code]/page.tsx': GOOD_DOCUMENT,
      '.gitignore': '.env*.local\n',
    });
    expect(check.ok).toBe(true);
    expect(check.warnings).toEqual([]);
  });

  it('warns about the older two-box search body, a missing document page, and an indexed one', () => {
    const older = site({
      'app/find/actions.ts': GOOD_ACTION.replace('{ q }', '{ reference, customer }'),
    });
    expect(older.ok).toBe(true);
    expect(codes(older.warnings)).toEqual(['no_document_page', 'old_lookup_body']);

    const indexed = site({
      'app/find/actions.ts': GOOD_ACTION,
      'app/documents/[code]/page.tsx': GOOD_DOCUMENT.replace('index: false', 'index: true'),
    });
    expect(codes(indexed.warnings)).toEqual(['page_indexed']);
  });

  it('finds the key written in code, in a NEXT_PUBLIC_ name and in browser code', () => {
    const check = site({
      'app/find/page.tsx': `'use client';
const key = '${KEY}';
export default function Page() {
  void fetch('/v1/website/documents/lookup', { method: 'POST', headers: { authorization: process.env.NEXT_PUBLIC_INTEGR8_WEBSITE_KEY } });
  return null;
}
`,
    });
    expect(check.ok).toBe(false);
    expect(codes(check.problems)).toEqual(['browser_code', 'key_in_code', 'public_env_name']);
    expect(check.problems.find((p) => p.code === 'key_in_code')).toMatchObject({
      file: 'app/find/page.tsx',
      line: 2,
    });
  });

  it('finds invented endpoints, as list searches are', () => {
    const check = site({
      'app/api/docs/route.ts': `export async function GET() {
  return fetch(process.env.INTEGR8_API_URL + '/v1/website/documents?search=x', { cache: 'no-store', headers: { authorization: 'Bearer ' + process.env.INTEGR8_WEBSITE_KEY } });
}
`,
    });
    expect(codes(check.problems)).toEqual(['unknown_endpoint']);
    expect(codes(check.warnings)).toEqual(['no_document_page', 'no_lookup']);
  });

  it('accepts the files endpoint with an id from a template literal', () => {
    const check = site({
      'lib/files.ts': `import 'server-only';
export const links = (id: string) =>
  fetch(\`\${process.env.INTEGR8_API_URL}/v1/website/files/\${id}\`, { cache: 'no-store', headers: { authorization: \`Bearer \${process.env.INTEGR8_WEBSITE_KEY}\` } });
`,
    });
    expect(check.problems).toEqual([]);
  });

  it('warns about a module not marked server-only, caching and kept links', () => {
    const check = site({
      'lib/integr8.ts': `export async function find(q: string) {
  const answer = await fetch(process.env.INTEGR8_API_URL + '/v1/website/documents/lookup', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.INTEGR8_WEBSITE_KEY }, body: JSON.stringify({ q }) });
  const body = await answer.json();
  localStorage.setItem('pdf', body.document.viewUrl);
}
`,
    });
    expect(check.ok).toBe(true);
    expect(codes(check.warnings)).toEqual([
      'links_kept',
      'may_be_cached',
      'no_document_page',
      'not_marked_server_only',
    ]);
  });

  it('finds the key logged or returned, and refusal reasons shown to visitors', () => {
    const check = site({
      'app/api/find/route.ts': `export async function POST() {
  console.log('key', process.env.INTEGR8_WEBSITE_KEY);
  console.error('Integr8: INTEGR8_WEBSITE_KEY is not set');
  return Response.json({ key: process.env.INTEGR8_WEBSITE_KEY });
}
`,
      'app/find/result.tsx': `'use client';
export const Result = ({ code }: { code: string }) => (code === 'website_key_invalid' ? 'Bad key' : null);
`,
    });
    expect(codes(check.problems)).toEqual(['key_in_response', 'key_logged']);
    expect(codes(check.warnings)).toEqual(['no_document_page', 'no_lookup', 'refusal_shown']);
  });

  it('reads env files: a key in .env.example is a problem, in .env a warning, in .env.local fine', () => {
    const check = site({
      '.env.example': `INTEGR8_WEBSITE_KEY=${KEY}\n`,
      '.env': `INTEGR8_WEBSITE_KEY=${KEY}\n`,
      '.env.local': `INTEGR8_WEBSITE_KEY=${KEY}\n`,
      '.gitignore': 'node_modules\n',
      'app/actions.ts': GOOD_ACTION,
      'app/documents/[code]/page.tsx': GOOD_DOCUMENT,
    });
    expect(codes(check.problems)).toEqual(['key_in_example_env']);
    expect(codes(check.warnings)).toEqual(['env_not_ignored', 'key_in_shared_env']);
  });

  it('skips node_modules and .next, and refuses a relative path', () => {
    const check = site({
      'node_modules/x/index.js': `const k = '${KEY}';`,
      '.next/server/page.js': `const k = '${KEY}';`,
      'app/actions.ts': GOOD_ACTION,
    });
    expect(check.ok).toBe(true);
    expect(check.scanned).toBe(1);
    expect(() => checkWebsite(['relative/folder'])).toThrow(/absolute/u);
  });

  it('formats a verdict, every finding with its place, and JSON', () => {
    const text = formatWebsiteCheck(site({ 'lib/a.ts': `export const k = '${KEY}';\n` }));
    expect(text).toMatch(/^NOT OK: 1 problem in 1 file/u);
    expect(text).toMatch(/1\. lib\/a\.ts:1 \[key_in_code\]/u);
    expect(text).toMatch(/As JSON:/u);
  });
});
