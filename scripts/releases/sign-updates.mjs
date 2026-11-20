#!/usr/bin/env node
/* global Buffer, console, process */
// Integr8's signed update list for one release (SEC-004).
//
// Forms for AI and the developer program replace themselves only with a file
// whose SHA-256 this list names, signed with Integr8's update key. The list
// covers every file of the release (each hashed here, never read from a
// `.sha256` beside it, which proves nothing about who made it):
//
//   integr8-update-manifest.json      {"format":1,"version":"X.Y.Z","files":{name: sha256}}
//   integr8-update-manifest.json.sig  base64 Ed25519 signature over the manifest's exact bytes
//
// The private key is `UPDATE_SIGNING_KEY` (PKCS#8 PEM), a secret of the
// `release` GitHub environment and nowhere else; its public half is built into
// both programs (`apps/forms-ai/src/setup/signature.ts`). Without the key the
// release goes out unsigned with a warning, and installed programs offer no
// update from it.
//
//   node scripts/releases/sign-updates.mjs --dir dist --version 2.1.0

import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'integr8-update-manifest.json';
export const SIGNATURE = `${MANIFEST}.sig`;

/** The manifest's bytes for the files in `dir`: name → SHA-256, names sorted. */
export function manifestFor(dir, version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`"${version}" is not a release version (X.Y.Z)`);
  }
  const files = {};
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (name === MANIFEST || name === SIGNATURE || !statSync(path).isFile()) {
      continue;
    }
    files[name] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  if (Object.keys(files).length === 0) {
    throw new Error(`${dir} holds no files to sign`);
  }
  return Buffer.from(`${JSON.stringify({ format: 1, version, files }, null, 2)}\n`);
}

/** Writes the manifest and its signature into `dir`. */
export function signRelease(dir, version, privateKeyPem) {
  const manifest = manifestFor(dir, version);
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('UPDATE_SIGNING_KEY is not an Ed25519 private key');
  }
  writeFileSync(join(dir, MANIFEST), manifest);
  writeFileSync(join(dir, SIGNATURE), `${sign(null, manifest, key).toString('base64')}\n`);
  return Object.keys(JSON.parse(manifest.toString('utf8')).files).length;
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  const dir = argument('dir');
  const version = argument('version');
  if (dir === undefined || version === undefined) {
    console.error('Usage: sign-updates.mjs --dir <release files> --version X.Y.Z');
    process.exit(2);
  }
  const key = process.env.UPDATE_SIGNING_KEY ?? '';
  if (key.trim() === '') {
    console.log(
      '::warning::No UPDATE_SIGNING_KEY in the release environment: this release has no signed update list, so installed Forms for AI and developer programs will not update from it.',
    );
    process.exit(0);
  }
  const count = signRelease(dir, version, key);
  console.log(`Signed the update list for ${version}: ${String(count)} files.`);
}
