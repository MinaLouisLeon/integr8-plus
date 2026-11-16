#!/usr/bin/env node
/* global console, process */
// Bundles the developer MCP server (P43) into one CommonJS file,
// dist/integr8-dev-mcp.cjs: the script its single executable runs
// (scripts/build-sea.mjs). Forms for AI's tools come with it; their preview
// page and fonts are read from the executable's assets, so Forms for AI must
// be built first (pnpm --filter @integr8/forms-ai build).
//
// Versions are written in at build time: this package's own (the MCP
// handshake), and the product's (what the program describes, sent as
// x-client-version): DEV_MCP_PRODUCT_VERSION when the release workflow passes
// one, else the root package.json.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
// The same exact-pinned esbuild Forms for AI builds with.
const { build } = createRequire(join(app, '..', 'forms-ai', 'package.json'))('esbuild');

export function versions() {
  const own = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).version;
  const product =
    process.env.DEV_MCP_PRODUCT_VERSION?.trim() ||
    JSON.parse(readFileSync(join(app, '..', '..', 'package.json'), 'utf8')).version;
  return { own, product };
}

export const BUNDLE = join(app, 'dist', 'integr8-dev-mcp.cjs');

export async function bundle() {
  const { own, product } = versions();
  await build({
    entryPoints: [join(app, 'src', 'cli.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    legalComments: 'eof',
    logLevel: 'warning',
    // Loaded from beside the executable (store.ts), never bundled: a native module.
    external: ['@napi-rs/keyring'],
    define: {
      __DEV_MCP_VERSION__: JSON.stringify(own),
      __DEV_MCP_PRODUCT_VERSION__: JSON.stringify(product),
      __FORMS_AI_VERSION__: JSON.stringify(product),
      // `import.meta.url` has no meaning in CommonJS; this file's own URL stands in.
      'import.meta.url': '__devMcpFileUrl',
    },
    banner: {
      js: "const __devMcpFileUrl = require('node:url').pathToFileURL(__filename).href;",
    },
  });
  // The program is released with the product and named by its version.
  return { version: product, own, file: BUNDLE };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, own, file } = await bundle();
  console.log(`Bundled ${version} (server ${own}) to ${file}`);
}
