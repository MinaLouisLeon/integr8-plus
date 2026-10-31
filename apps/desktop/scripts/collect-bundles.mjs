#!/usr/bin/env node
/**
 * Gathers what `tauri build` produced on this machine into one folder for the
 * release: the installers under names GitHub keeps, their update signatures,
 * and this platform's part of the updater manifest (see updater-feed.mjs).
 *
 *   node apps/desktop/scripts/collect-bundles.mjs \
 *     --paths '["…/Integr8 Plus Staff_1.2.3_x64-setup.exe", …]' \
 *     --out collected --prefix integr8-plus-staff --version 1.2.3
 *
 * `--paths` is tauri-action's `artifactPaths`. On macOS that includes the bare
 * `.app` folder beside the `.dmg`; a folder cannot be attached to a release,
 * so only regular files are kept. The product name is read from the stamped
 * tauri.conf.json, which is what Tauri named the files after.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planCollection, updaterArch, updaterOs } from './updater-feed.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

const out = arg('out');
const prefix = arg('prefix');
const version = arg('version');
const configPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));
const { productName } = JSON.parse(readFileSync(configPath, 'utf8'));

const files = [];
for (const path of JSON.parse(arg('paths'))) {
  if (!statSync(path).isFile()) {
    console.log('skipped (not a file)', path);
    continue;
  }
  files.push(path);
  // tauri-action does not always list the signatures it made; they sit beside
  // the bundle they sign.
  if (!path.endsWith('.sig') && existsSync(`${path}.sig`) && !files.includes(`${path}.sig`)) {
    files.push(`${path}.sig`);
  }
}

const { copies, fragment } = planCollection({
  files: [...new Set(files)],
  productName,
  prefix,
  version,
  os: updaterOs(process.platform),
  arch: updaterArch(process.arch),
  readSignature: (file) => readFileSync(file, 'utf8'),
});

mkdirSync(out, { recursive: true });
for (const { from, to } of copies) {
  copyFileSync(from, join(out, to));
  console.log('collected', to);
}
if (fragment === undefined) {
  console.log('No signed update bundles: this build cannot be offered as an update.');
} else {
  writeFileSync(join(out, fragment.name), `${JSON.stringify(fragment.content, null, 2)}\n`);
  console.log('updater entries', Object.keys(fragment.content.platforms).join(', '));
}
