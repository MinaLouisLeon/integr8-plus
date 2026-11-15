import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt, inlineGuide, sitePage } from './build-site.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'deployment');
const read = (name) => readFileSync(join(dir, name), 'utf8');

test('the guide opens with the right username and password, and only with them', async () => {
  const sealed = await encrypt('<p>the guide</p>', 'Staff', 'a long password');
  assert.equal(await decrypt(sealed, 'staff ', 'a long password'), '<p>the guide</p>');
  await assert.rejects(decrypt(sealed, 'staff', 'a long passwore'));
  await assert.rejects(decrypt(sealed, 'someone', 'a long password'));
});

test('the published page carries no readable guide and no credentials', async () => {
  const guide = inlineGuide(
    read('setup-checklist.html'),
    read('setup-checklist.css'),
    read('setup-checklist.js'),
  );
  assert.match(guide, /<style>/u);
  assert.doesNotMatch(guide, /setup-checklist\.(css|js)"/u);
  const page = sitePage(await encrypt(guide, 'staff', 'a long password'));
  assert.doesNotMatch(page, /Stage 11|deploy\/compose\.yml|a long password/u);
  assert.match(page, /noindex/u);
});
