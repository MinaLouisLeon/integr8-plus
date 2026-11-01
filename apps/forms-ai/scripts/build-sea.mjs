#!/usr/bin/env node
/* global console, process */
// Builds the single executable for the computer it runs on (Node's Single
// Executable Applications): the bundle, plus pdf.js and the website fonts as
// SEA assets, injected into a copy of this Node binary. The release workflow
// runs it on a Windows, a macOS (arm64 and x64) and a Linux runner.
//
//   node scripts/build-sea.mjs [--out <folder>]
//
// Writes <out>/integr8-forms-ai-<version>-<os>-<arch>[.exe] and a .sha256
// beside it (default out: dist/release), then runs the result once to prove
// it starts. On macOS the binary is signed ad hoc after injection, without
// which Apple Silicon refuses to run it at all.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(app, 'package.json'));
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const outFlag = process.argv.indexOf('--out');
const out = outFlag === -1 ? join(app, 'dist', 'release') : process.argv[outFlag + 1];

const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
if (os === undefined || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error(`No build for ${process.platform} ${process.arch}.`);
}

const { version, file: main } = await bundle();
const name = `integr8-forms-ai-${version}-${os}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const work = join(app, 'dist', 'sea');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

/** Where an asset's file is: through the package's exports, or beside its package.json. */
function assetPath({ packageName, file }) {
  try {
    return require.resolve(`${packageName}/${file}`);
  } catch {
    return join(dirname(require.resolve(`${packageName}/package.json`)), file);
  }
}

// The bundle names its own assets, so the list is never kept twice.
const assets = JSON.parse(
  execFileSync(process.execPath, [main, '--sea-assets'], { encoding: 'utf8' }),
);
const config = {
  main,
  output: join(work, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  // Off: a code cache is tied to the exact V8 build and saves little here.
  useCodeCache: false,
  assets: Object.fromEntries(
    assets.map((asset) => [`${asset.packageName}/${asset.file}`, assetPath(asset)]),
  ),
};
writeFileSync(join(work, 'sea-config.json'), JSON.stringify(config, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', join(work, 'sea-config.json')], {
  stdio: 'inherit',
});

const target = join(out, name);
rmSync(target, { force: true });
copyFileSync(process.execPath, target);
chmodSync(target, 0o755);
if (process.platform === 'darwin') {
  // Injection invalidates Node's own signature; it is removed first and the
  // result signed again ad hoc below.
  execFileSync('codesign', ['--remove-signature', target], { stdio: 'inherit' });
}

const { inject } = require('postject');
await inject(target, 'NODE_SEA_BLOB', readFileSync(config.output), {
  sentinelFuse: SENTINEL,
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', target], { stdio: 'inherit' });
}

const reported = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) {
  throw new Error(`The executable says it is ${reported}, not ${version}.`);
}

const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
writeFileSync(`${target}.sha256`, `${hash}  ${basename(target)}\n`);
console.log(`Built ${target} (${String(readFileSync(target).length)} bytes, sha256 ${hash})`);
