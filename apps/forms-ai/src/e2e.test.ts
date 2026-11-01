import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle } from '../scripts/bundle.mjs';
import { findExample, type FormExample } from './mcp/examples.js';
import { selfTest } from './setup/self-test.js';
import { VERSION } from './version.js';

/**
 * The real thing over stdio: the bundled program (what the single executable
 * runs) started as `serve`, spoken to with the MCP client AI tools use, and
 * the installer run without a terminal.
 */

const root = mkdtempSync(join(tmpdir(), 'forms-ai-e2e-'));
const home = join(root, 'home');
let program: string;

const env = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: home,
  USERPROFILE: home,
  INTEGR8_FORMS_HOME: join(root, 'install'),
  INTEGR8_FORMS_OUTPUT: join(root, 'out'),
  INTEGR8_FORMS_NO_UPDATE_CHECK: '1',
  // No previews in this suite: the browser path is covered by preview.test.ts.
  INTEGR8_FORMS_BROWSER: join(root, 'no-browser'),
});

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  program = (await bundle()).file;
}, 120_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the bundled program', () => {
  it('prints its version', () => {
    const result = spawnSync(process.execPath, [program, '--version'], { encoding: 'utf8' });
    expect(result.stdout.trim()).toBe(VERSION);
  });

  it('passes the installer’s self-test over stdio', async () => {
    const result = await selfTest(process.execPath, [program, 'serve'], { env: env() });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.serverVersion).toBe(VERSION);
  });

  it('saves a package when an MCP client asks', async () => {
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [program, 'serve'],
        env: env(),
        stderr: 'pipe',
      }),
    );
    try {
      const definition = (findExample('job_completion') as FormExample).definition;
      const checked = (await client.callTool({
        name: 'check_form',
        arguments: { definition },
      })) as {
        content: { text: string }[];
      };
      expect(checked.content[0]?.text).toMatch(/^OK/u);
      const saved = (await client.callTool({
        name: 'save_package',
        arguments: { definition, fileName: 'Job completion' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(saved.isError).not.toBe(true);
      expect(existsSync(join(root, 'out', 'Job completion.integr8form'))).toBe(true);
      const preview = (await client.callTool({
        name: 'preview_pdf',
        arguments: {
          definition,
          template: {
            name: 'Empty',
            design: {
              schemaVersion: 2,
              page: { margins: { top: 20, end: 15, bottom: 20, start: 15 } },
              blocks: [],
            },
          },
        },
      })) as { content: { text: string }[] };
      expect(preview.content[0]?.text).toMatch(/No preview/u);
    } finally {
      await client.close();
    }
  });

  it('runs the installer without a terminal: status, self-test, numbered menu', () => {
    const status = spawnSync(
      process.execPath,
      [program, 'setup', '--status', '--self-test', '--no-update-check'],
      {
        encoding: 'utf8',
        env: env(),
        timeout: 60_000,
      },
    );
    expect(status.stderr).toBe('');
    expect(status.stdout).toMatch(/Integr8 Forms for AI/u);
    expect(status.stdout).toMatch(/Running from source/u);
    expect(status.stdout).toMatch(/Server .* answered with 9 tools/u);
    expect(status.stdout).toMatch(/Windsurf\s+not found on this computer/u);
    expect(status.status).toBe(0);

    const menu = spawnSync(process.execPath, [program], {
      encoding: 'utf8',
      env: env(),
      input: '5\n6\n',
      timeout: 60_000,
    });
    expect(menu.stdout).toMatch(/1\. Connect to AI tools/u);
    expect(menu.stdout).toMatch(/Output folder: /u);
    expect(menu.status).toBe(0);
  });
});
