/* global Buffer */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MANIFEST, manifestFor, SIGNATURE, signRelease } from './sign-updates.mjs';

const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sign-updates-'));
  writeFileSync(join(dir, 'integr8-forms-ai-2.1.0-linux-x64'), 'program');
  writeFileSync(join(dir, 'integr8-forms-ai-2.1.0-linux-x64.sha256'), 'not trusted');
  return dir;
};

test('the manifest names every file with its own hash, sorted', () => {
  const dir = folder();
  try {
    const manifest = JSON.parse(manifestFor(dir, '2.1.0').toString('utf8'));
    assert.equal(manifest.format, 1);
    assert.equal(manifest.version, '2.1.0');
    assert.deepEqual(Object.keys(manifest.files), [
      'integr8-forms-ai-2.1.0-linux-x64',
      'integr8-forms-ai-2.1.0-linux-x64.sha256',
    ]);
    assert.equal(
      manifest.files['integr8-forms-ai-2.1.0-linux-x64'],
      createHash('sha256').update('program').digest('hex'),
    );
    assert.throws(() => manifestFor(dir, 'v2.1.0'), /not a release version/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the signature verifies with the public key, and only over the exact bytes', () => {
  const dir = folder();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  try {
    const count = signRelease(dir, '2.1.0', privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.equal(count, 2);
    const manifest = readFileSync(join(dir, MANIFEST));
    const signature = Buffer.from(readFileSync(join(dir, SIGNATURE), 'utf8').trim(), 'base64');
    assert.equal(verify(null, manifest, publicKey, signature), true);
    const changed = Buffer.from(manifest.toString('utf8').replace('2.1.0', '2.1.1'));
    assert.equal(verify(null, changed, publicKey, signature), false);
    // Signing again leaves the old list out of the new one.
    signRelease(dir, '2.1.0', privateKey.export({ type: 'pkcs8', format: 'pem' }));
    assert.equal(
      Object.keys(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')).files).length,
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key that is not Ed25519 is refused', () => {
  const dir = folder();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  try {
    assert.throws(
      () => signRelease(dir, '2.1.0', privateKey.export({ type: 'pkcs8', format: 'pem' })),
      /not an Ed25519/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
