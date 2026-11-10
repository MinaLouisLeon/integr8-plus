#!/usr/bin/env node
/* global console, process */
// Bundles the tool into one CommonJS file, dist/integr8-forms-ai.cjs: the
// script a Node single executable runs (scripts/build-sea.mjs), and what
// `node dist/integr8-forms-ai.cjs serve` runs during development. Then the
// preview window's page (P37): dist/window/page.js for the browser and
// dist/window/page.css, compiled with Tailwind, the website fonts inlined so
// the page loads nothing but these two files.
//
// The version is written in at build time: FORMS_AI_VERSION when the release
// workflow passes one (a nightly's full version), else the root package.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, optimize } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { build } from 'esbuild';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');

export function productVersion() {
  const fromEnv = process.env.FORMS_AI_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return JSON.parse(readFileSync(join(app, '..', '..', 'package.json'), 'utf8')).version;
}

export const BUNDLE = join(app, 'dist', 'integr8-forms-ai.cjs');
export const PAGE_DIR = join(app, 'dist', 'window');
const PAGE_SOURCE = join(app, 'src', 'window', 'page');

/** The page's stylesheet: Tailwind over the page and the filler's classes, then the fonts. */
async function pageStyles() {
  const input = readFileSync(join(PAGE_SOURCE, 'styles.css'), 'utf8');
  const compiler = await compile(input, { base: PAGE_SOURCE, onDependency: () => undefined });
  const sources = [
    ...(compiler.root === 'none'
      ? []
      : compiler.root === null
        ? [{ base: PAGE_SOURCE, pattern: '**/*', negated: false }]
        : [{ ...compiler.root, negated: false }]),
    ...compiler.sources,
  ];
  const tailwind = optimize(compiler.build(new Scanner({ sources }).scan()), {
    minify: false,
  }).code;
  const result = await build({
    stdin: {
      contents: `@import '@integr8/tokens/fonts.css';
${tailwind}`,
      resolveDir: PAGE_SOURCE,
      loader: 'css',
      sourcefile: 'page.css',
    },
    bundle: true,
    write: false,
    minify: true,
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl' },
    logLevel: 'warning',
  });
  return result.outputFiles[0].contents;
}

export async function bundlePage() {
  mkdirSync(PAGE_DIR, { recursive: true });
  await build({
    entryPoints: [join(PAGE_SOURCE, 'main.tsx')],
    outfile: join(PAGE_DIR, 'page.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome111', 'edge111', 'firefox115', 'safari16.4'],
    jsx: 'automatic',
    minify: true,
    legalComments: 'eof',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  writeFileSync(join(PAGE_DIR, 'page.css'), await pageStyles());
  return PAGE_DIR;
}

export async function bundle() {
  const version = productVersion();
  await build({
    entryPoints: [join(app, 'src', 'main.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // The packages' own licence notices travel with the code.
    legalComments: 'eof',
    logLevel: 'warning',
    define: {
      __FORMS_AI_VERSION__: JSON.stringify(version),
      // `import.meta.url` has no meaning in CommonJS; this file's own URL stands in.
      'import.meta.url': '__formsAiFileUrl',
    },
    banner: {
      js: "const __formsAiFileUrl = require('node:url').pathToFileURL(__filename).href;",
    },
  });
  await bundlePage();
  return { version, file: BUNDLE };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, file } = await bundle();
  console.log(`Bundled ${version} to ${file}`);
}
