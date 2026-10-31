#!/usr/bin/env node
/**
 * Merges the build machines' updater fragments in a release folder into the
 * one `latest.json` the desktop update feed serves, and removes the fragments
 * so they are not attached to the release (see updater-feed.mjs).
 *
 *   node apps/desktop/scripts/updater-manifest.mjs --dir dist --version 1.2.3 \
 *     --download-base "https://github.com/OWNER/REPO/releases/download/v1.2.3"
 *
 * No fragments (desktop builds switched off, or no updater signing key) means
 * no manifest: the feed then keeps offering the previous release.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildManifest, FRAGMENT_PATTERN } from './updater-feed.mjs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

const dir = arg('dir');
const names = readdirSync(dir).filter((name) => FRAGMENT_PATTERN.test(name));
if (names.length === 0) {
  console.log('No updater fragments: no latest.json for this release.');
  process.exit(0);
}

const fragments = names.map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
const manifest = buildManifest({
  fragments,
  version: arg('version'),
  notes: `Version ${arg('version')}`,
  pubDate: new Date().toISOString(),
  downloadBase: arg('download-base'),
});
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of names) rmSync(join(dir, name));
console.log('latest.json for', Object.keys(manifest.platforms).join(', '));
