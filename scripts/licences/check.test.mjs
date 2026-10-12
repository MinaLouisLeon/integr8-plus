import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowed } from './check.mjs';

test('permissive licences and expressions pass, others fail', () => {
  assert.equal(allowed('MIT'), true);
  assert.equal(allowed('(MIT OR Apache-2.0)'), true);
  assert.equal(allowed('(BSD-3-Clause OR GPL-2.0)'), true);
  assert.equal(allowed('MIT AND Apache-2.0'), true);
  assert.equal(allowed('MIT AND GPL-3.0'), false);
  assert.equal(allowed('GPL-3.0'), false);
  assert.equal(allowed('LGPL-3.0-or-later'), false);
  assert.equal(allowed('UNKNOWN'), false);
  assert.equal(allowed(''), false);
});
