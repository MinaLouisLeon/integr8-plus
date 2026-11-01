#!/usr/bin/env node
/* global console, process */
// Bundles the tool into one CommonJS file, dist/integr8-forms-ai.cjs: the
// script a Node single executable runs (scripts/build-sea.mjs), and what
// `node dist/integr8-forms-ai.cjs serve` runs during development.
//
// The version is written in at build time: FORMS_AI_VERSION when the release
// workflow passes one (a nightly's full version), else the root package.json.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  return { version, file: BUNDLE };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, file } = await bundle();
  console.log(`Bundled ${version} to ${file}`);
}
