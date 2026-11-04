import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { transform } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { checkWebsite } from './check.js';
import { nextExample, nextExampleText, type NextExampleOptions } from './nextjs.js';

/**
 * Every variant of the example compiles (TypeScript and JSX syntax, through
 * esbuild: the project has no Next.js types to type-check against) and
 * passes the program's own website check with no problem and no warning.
 */

const root = mkdtempSync(join(tmpdir(), 'forms-ai-website-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const VARIANTS: NextExampleOptions[] = [
  {},
  { language: 'ar' },
  { language: 'en', srcDir: true },
  { route: '[locale]/documents/find', documentRoute: '[locale]/d', srcDir: true },
];

describe('the Next.js example', () => {
  VARIANTS.forEach((options, index) => {
    it(`compiles and passes the check: ${JSON.stringify(options)}`, async () => {
      const files = nextExample(options);
      const folder = join(root, `site-${String(index)}`);
      for (const file of files) {
        if (file.path.endsWith('.ts') || file.path.endsWith('.tsx')) {
          await expect(
            transform(file.content, {
              loader: file.path.endsWith('.tsx') ? 'tsx' : 'ts',
              jsx: 'automatic',
              format: 'esm',
            }),
          ).resolves.toBeDefined();
        }
        const target = join(folder, file.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.content);
      }
      writeFileSync(join(folder, '.gitignore'), 'node_modules\n.env*.local\n');
      writeFileSync(join(folder, '.env.local'), `INTEGR8_WEBSITE_KEY=i8wk_${'k'.repeat(43)}\n`);
      const check = checkWebsite([folder]);
      expect(check.problems).toEqual([]);
      expect(check.warnings).toEqual([]);
      expect(check.scanned).toBe(files.length + 1);
    });
  });

  it('places the files where asked', () => {
    const paths = nextExample({ route: 'certificates', srcDir: true }).map((file) => file.path);
    expect(paths).toEqual([
      'src/lib/integr8.ts',
      'src/app/certificates/actions.ts',
      'src/app/certificates/document-search.tsx',
      'src/app/certificates/page.tsx',
      'src/app/documents/[code]/page.tsx',
      '.env.example',
    ]);
  });

  it('searches with one box and opens a document by its code', () => {
    const files = nextExample();
    const form = files.find((file) => file.path.endsWith('document-search.tsx'))!.content;
    expect(form).toMatch(/name="q"/u);
    expect(form).not.toMatch(/name="customer"/u);
    const client = files.find((file) => file.path.endsWith('lib/integr8.ts'))!.content;
    expect(client).toMatch(/JSON\.stringify\(\{ q \}\)/u);
    expect(client).toMatch(/\/v1\/website\/documents\/by-code\//u);
    const page = files.find((file) => file.path.endsWith('[code]/page.tsx'))!.content;
    expect(page).toMatch(/documentByCode\(code\)/u);
    expect(page).toMatch(/index: false/u);
  });

  it('refuses a route that is not a folder name, or one page in two places', () => {
    expect(() => nextExample({ route: '../secrets' })).toThrow(/not a route folder/u);
    expect(() => nextExample({ documentRoute: '../x' })).toThrow(/not a route folder/u);
    expect(() => nextExample({ route: 'docs', documentRoute: 'docs' })).toThrow(/different/u);
  });

  it('reads as one text with every file', () => {
    const text = nextExampleText();
    expect(text).toMatch(/## lib\/integr8\.ts/u);
    expect(text).toMatch(/npm install server-only/u);
    expect(text).toMatch(/check_website_integration/u);
    expect(text).toMatch(/document link address/u);
  });
});
