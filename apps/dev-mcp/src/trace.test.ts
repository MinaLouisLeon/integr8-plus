import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { privateFolder, Trace } from './trace.js';

/**
 * The trace folder sits in the shared temporary folder on Linux, so it must be
 * this user's alone: made or narrowed to 0700, and a link put there by someone
 * else is refused instead of followed.
 */

const root = mkdtempSync(join(tmpdir(), 'dev-mcp-trace-folder-'));
const posixOnly = process.platform === 'win32' ? it.skip : it;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the trace folder', () => {
  posixOnly('is made readable by this user only', () => {
    const trace = new Trace({ folder: join(root, 'new') });
    expect(statSync(join(root, 'new')).mode & 0o777).toBe(0o700);
    expect(trace.file).toMatch(/trace-.+\.jsonl$/u);
  });

  posixOnly('narrows a folder that already existed with a wider mode', () => {
    const folder = join(root, 'wide');
    mkdirSync(folder, { mode: 0o777 });
    privateFolder(folder);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  posixOnly('refuses a link in its place', () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const link = join(root, 'link');
    symlinkSync(elsewhere, link);
    expect(() => privateFolder(link)).toThrow(/not a folder/u);
  });
});
