import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleValueProblems } from '@integr8/core';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * deploy/vps/check-env.sh is what the setup guide has the operator run to see
 * which settings in deploy/.env still hold an example value. It is plain sh so
 * it runs on the machine with nothing installed, which means it repeats the
 * rule production starts by (`exampleValueProblems`); this keeps the two in
 * step, and checks it never prints a value.
 *
 * Skipped where there is no `sh` (a Windows shell without Git Bash on the path).
 */

const script = fileURLToPath(new URL('../../../deploy/vps/check-env.sh', import.meta.url));
const template = fileURLToPath(new URL('../../../deploy/.env.example', import.meta.url));
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;

const scratch = mkdtempSync(join(tmpdir(), 'integr8-check-env-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(file: string): { status: number | null; out: string } {
  const result = spawnSync('sh', [script, file], { encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** The template as an environment, the way compose would read it. */
function templateEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(template, 'utf8').split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] !== undefined) {
      env[match[1]] = match[2] ?? '';
    }
  }
  return env;
}

describe.skipIf(!hasSh)('the env file check', () => {
  it('lists every setting of the untouched template that production would refuse', () => {
    const { status, out } = run(template);
    expect(status).toBe(1);
    const listed = new Set(
      [...out.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gmu)].map((match) => match[1] ?? ''),
    );
    const refused = exampleValueProblems(templateEnv()).map(
      (problem) => /([A-Z][A-Z0-9_]*) /u.exec(problem)?.[1] ?? problem,
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.filter((name) => !listed.has(name))).toEqual([]);
    // Names only: not one of the template's values is printed.
    expect(out).not.toContain('change-me-owner-password');
    expect(out).not.toContain('api.your-domain.example');
  });

  it('lists short passwords and placeholder hosts, and ignores commented lines', () => {
    const file = join(scratch, 'partly.env');
    writeFileSync(
      file,
      [
        '# POSTGRES_PASSWORD=change-me',
        'POSTGRES_PASSWORD="0123456789abcdef0123"',
        'INTEGR8_APP_PASSWORD=too-short',
        'DATABASE_URL=postgres://integr8_app:tiny@postgres:5432/integr8',
        'AUTH_ISSUER=https://api.integr8.local',
        'API_UPDATE_URL=https://integr8.example/download',
        'WEB_APP_URL=https://app.integr8-media.com',
        '',
      ].join('\r\n'),
    );
    const { status, out } = run(file);
    expect(status).toBe(1);
    const listed = [...out.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gmu)].map((match) => match[1]);
    expect(listed).toEqual([
      'INTEGR8_APP_PASSWORD',
      'DATABASE_URL',
      'AUTH_ISSUER',
      'API_UPDATE_URL',
    ]);
    expect(out).not.toContain('too-short');
    expect(out).not.toContain('tiny');
  });

  it('says so when nothing is left', () => {
    const file = join(scratch, 'clean.env');
    writeFileSync(
      file,
      [
        'POSTGRES_PASSWORD=0123456789abcdef0123456789abcdef',
        'DATABASE_URL_ADMIN=postgres://postgres:0123456789abcdef0123456789abcdef@postgres:5432/integr8',
        'WEB_APP_URL=https://app.integr8-media.com',
        'AUTH_ISSUER=https://api.integr8-media.com',
        'API_CORS_ORIGINS=https://app.integr8-media.com,tauri://localhost,http://tauri.localhost',
        'HR_DATA_KEY=',
        '',
      ].join('\n'),
    );
    const { status, out } = run(file);
    expect(out).toMatch(/no example values left/u);
    expect(status).toBe(0);
  });
});
