import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASES } from './cases.js';
import { runConformance } from './run.js';

const GOLDEN = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'conformance',
  'golden.jsonl',
);

describe('the conformance corpus', () => {
  it('reproduces the golden file in Node, byte for byte', () => {
    // If this fails after an intended change, regenerate with
    // `pnpm --filter @integr8/form-engine conformance:golden` and read the diff.
    expect(`${runConformance()}\n`).toBe(readFileSync(GOLDEN, 'utf8').replace(/\r\n/gu, '\n'));
  });

  it('gives the same bytes on a second run in the same process', () => {
    expect(runConformance()).toBe(runConformance());
  });

  it('has one line per case, each naming its case', () => {
    const lines = runConformance().split('\n');
    expect(lines).toHaveLength(CASES.length);
    lines.forEach((line, index) => {
      expect(JSON.parse(line)).toMatchObject({ name: CASES[index]?.name });
    });
  });
});
