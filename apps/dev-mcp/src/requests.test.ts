import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getRepoRequest, listRepoRequests } from './requests.js';

const folder = mkdtempSync(join(tmpdir(), 'dev-mcp-requests-'));
afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

mkdirSync(join(folder, 'CR-0002-mileage-claims'));
writeFileSync(
  join(folder, 'CR-0002-mileage-claims', 'request.md'),
  [
    '# CR-0002 — Mileage claims from a form',
    '',
    '| Field | Value |',
    '| ----- | ----- |',
    '| Number | 2 |',
    '| Kind | `form_action` |',
    '| Status | `handed_over` |',
    '',
    '## What was wanted',
    '',
    'Claims made from the trip form.',
    '',
  ].join('\n'),
);
writeFileSync(join(folder, 'CR-0002-mileage-claims', 'example.integr8form'), 'zip');
writeFileSync(
  join(folder, 'CR-0001-form-actions.md'),
  '# CR-0001 — Form actions\r\n\r\n**Date:** 2026-11-10\r\n**Kind:** `form_action`\r\n**Status:** `received` — not planned yet.\r\n',
);
writeFileSync(join(folder, 'README.md'), '# Change requests');

describe('change requests in the repository', () => {
  it('lists folders from Forms for AI and notes written by hand', () => {
    expect(
      listRepoRequests(folder).map(({ code, title, kind, status, files }) => ({
        code,
        title,
        kind,
        status,
        files,
      })),
    ).toEqual([
      {
        code: 'CR-0001',
        title: 'Form actions',
        kind: 'form_action',
        status: 'received',
        files: [],
      },
      {
        code: 'CR-0002',
        title: 'Mileage claims from a form',
        kind: 'form_action',
        status: 'handed_over',
        files: ['example.integr8form', 'request.md'],
      },
    ]);
  });

  it('reads one by code or number', () => {
    expect(getRepoRequest('cr-0002', folder)?.text).toMatch(/Claims made from the trip form/u);
    expect(getRepoRequest(1, folder)?.title).toBe('Form actions');
    expect(getRepoRequest(9, folder)).toBeUndefined();
  });

  it('finds the first request in this repository', () => {
    expect(listRepoRequests().map((request) => request.code)).toContain('CR-0001');
  });
});
