import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { getEntry } from './jsonc.js';
import type { RunResult, Runner } from './runner.js';
import {
  CLAUDE_CODE,
  CLAUDE_DESKTOP,
  CODEX,
  CURSOR,
  GEMINI,
  type ToolAdapter,
  type ToolContext,
  VSCODE,
  WINDSURF,
} from './tools.js';

let home: string;
const PROGRAM = '/home/mina/.local/share/integr8/forms-ai/integr8-forms-ai';

class FakeRunner implements Runner {
  readonly calls: { file: string; args: readonly string[] }[] = [];
  constructor(
    readonly found: Readonly<Record<string, string>> = {},
    readonly answer: (args: readonly string[]) => RunResult = () => ({
      code: 0,
      stdout: '',
      stderr: '',
    }),
  ) {}
  which(name: string): string | undefined {
    return this.found[name];
  }
  run(file: string, args: readonly string[]): Promise<RunResult> {
    this.calls.push({ file, args });
    return Promise.resolve(this.answer(args));
  }
}

function context(
  platform: NodeJS.Platform,
  runner: Runner = new FakeRunner(),
  env: Record<string, string> = {},
): ToolContext {
  const host: Host = {
    platform,
    arch: 'x64',
    home,
    env: { ...env, XDG_CONFIG_HOME: join(home, '.config') },
  };
  return { host, program: PROGRAM, runner, now: () => new Date('2026-11-01T09:30:00Z') };
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const backups = (file: string) =>
  readdirSync(dirname(file)).filter((name) =>
    name.startsWith(`${file.split('/').pop() ?? ''}.integr8-backup-`),
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forms-ai-tools-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface JsonCase {
  tool: ToolAdapter;
  platform: NodeJS.Platform;
  file: () => string;
  section: string;
  expected: Record<string, unknown>;
}

const JSON_CASES: JsonCase[] = [
  {
    tool: CLAUDE_DESKTOP,
    platform: 'darwin',
    file: () =>
      join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    section: 'mcpServers',
    expected: { command: PROGRAM, args: ['serve'] },
  },
  {
    tool: CLAUDE_DESKTOP,
    platform: 'linux',
    file: () => join(home, '.config', 'Claude', 'claude_desktop_config.json'),
    section: 'mcpServers',
    expected: { command: PROGRAM, args: ['serve'] },
  },
  {
    tool: CURSOR,
    platform: 'linux',
    file: () => join(home, '.cursor', 'mcp.json'),
    section: 'mcpServers',
    expected: { command: PROGRAM, args: ['serve'] },
  },
  {
    tool: VSCODE,
    platform: 'darwin',
    file: () => join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
    section: 'servers',
    expected: { type: 'stdio', command: PROGRAM, args: ['serve'] },
  },
  {
    tool: VSCODE,
    platform: 'linux',
    file: () => join(home, '.config', 'Code', 'User', 'mcp.json'),
    section: 'servers',
    expected: { type: 'stdio', command: PROGRAM, args: ['serve'] },
  },
  {
    tool: WINDSURF,
    platform: 'linux',
    file: () => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    section: 'mcpServers',
    expected: { command: PROGRAM, args: ['serve'] },
  },
  {
    tool: GEMINI,
    platform: 'linux',
    file: () => join(home, '.gemini', 'settings.json'),
    section: 'mcpServers',
    expected: { command: PROGRAM, args: ['serve'] },
  },
];

describe.each(
  JSON_CASES.map((entry) => [`${entry.tool.name} (${entry.platform})`, entry] as const),
)('%s settings file', (_name, { tool, platform, file, section, expected }) => {
  it('is not found without its folder', async () => {
    expect((await tool.status(context(platform))).kind).toBe('not_found');
  });

  it('installs beside other entries with a backup, is idempotent, removes cleanly', async () => {
    const path = file();
    const original = `{\n  "theme": "dark",\n  "${section}": {\n    "other": { "command": "other-server" }\n  }\n}\n`;
    write(path, original);
    const ctx = context(platform);
    expect((await tool.status(ctx)).kind).toBe('not_installed');

    const installed = await tool.install(ctx);
    expect(installed.ok).toBe(true);
    expect(installed.backup).toBeDefined();
    expect(readFileSync(installed.backup ?? '', 'utf8')).toBe(original);
    const text = readFileSync(path, 'utf8');
    expect(getEntry(text, section, 'integr8-forms')).toEqual(expected);
    expect(getEntry(text, section, 'other')).toEqual({ command: 'other-server' });
    expect(JSON.parse(text)).toMatchObject({ theme: 'dark' });
    expect((await tool.status(ctx)).kind).toBe('installed');

    const again = await tool.install(ctx);
    expect(again.message).toMatch(/Already set up/u);
    expect(backups(path)).toHaveLength(1);

    const removed = await tool.remove(ctx);
    expect(removed.ok).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect((await tool.status(ctx)).kind).toBe('not_installed');
    expect((await tool.remove(ctx)).message).toBe('Nothing to remove.');
  });

  it('creates the file when only the folder exists, and fixes an entry with an old path', async () => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const ctx = context(platform);
    const created = await tool.install(ctx);
    expect(created.backup).toBeUndefined();
    expect(getEntry(readFileSync(path, 'utf8'), section, 'integr8-forms')).toEqual(expected);

    write(
      path,
      JSON.stringify({
        [section]: { 'integr8-forms': { command: '/Downloads/old', args: ['serve'] } },
      }),
    );
    const state = await tool.status(ctx);
    expect(state).toMatchObject({ kind: 'other_path', command: '/Downloads/old' });
    await tool.install(ctx);
    expect((await tool.status(ctx)).kind).toBe('installed');
  });

  it('leaves a broken settings file alone', async () => {
    const path = file();
    write(path, '{ "oops": ');
    const outcome = await tool.install(context(platform));
    expect(outcome.ok).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('{ "oops": ');
    expect(backups(path)).toHaveLength(0);
  });
});

describe('Claude Code', () => {
  it('is not found without the claude command', async () => {
    expect((await CLAUDE_CODE.status(context('linux'))).kind).toBe('not_found');
  });

  it('installs with claude mcp add --scope user, after removing any old entry', async () => {
    const runner = new FakeRunner({ claude: '/usr/bin/claude' });
    const outcome = await CLAUDE_CODE.install(context('linux', runner));
    expect(outcome.ok).toBe(true);
    expect(runner.calls).toEqual([
      { file: '/usr/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'integr8-forms'] },
      {
        file: '/usr/bin/claude',
        args: ['mcp', 'add', '--scope', 'user', 'integr8-forms', '--', PROGRAM, 'serve'],
      },
    ]);
  });

  it('reads its state from ~/.claude.json (or CLAUDE_CONFIG_DIR)', async () => {
    const runner = new FakeRunner({ claude: '/usr/bin/claude' });
    write(
      join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'integr8-forms': { type: 'stdio', command: PROGRAM, args: ['serve'], env: {} },
        },
      }),
    );
    expect((await CLAUDE_CODE.status(context('linux', runner))).kind).toBe('installed');
    const elsewhere = join(home, 'claude-config');
    expect(
      (await CLAUDE_CODE.status(context('linux', runner, { CLAUDE_CONFIG_DIR: elsewhere }))).kind,
    ).toBe('not_installed');
  });

  it('reports a failed add', async () => {
    const runner = new FakeRunner({ claude: '/usr/bin/claude' }, (args) =>
      args[1] === 'add'
        ? { code: 1, stdout: '', stderr: 'boom' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const outcome = await CLAUDE_CODE.install(context('linux', runner));
    expect(outcome).toMatchObject({ ok: false, message: 'claude mcp add failed: boom' });
  });
});

describe('Codex', () => {
  it('uses codex mcp add when the command exists', async () => {
    const runner = new FakeRunner({ codex: '/usr/bin/codex' });
    await CODEX.install(context('linux', runner));
    expect(runner.calls).toEqual([
      { file: '/usr/bin/codex', args: ['mcp', 'remove', 'integr8-forms'] },
      { file: '/usr/bin/codex', args: ['mcp', 'add', 'integr8-forms', '--', PROGRAM, 'serve'] },
    ]);
  });

  it('edits config.toml (CODEX_HOME respected) when it does not, with a backup', async () => {
    const codexHome = join(home, 'codex-home');
    const file = join(codexHome, 'config.toml');
    const original = 'model = "o4"\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n';
    write(file, original);
    const ctx = context('linux', new FakeRunner(), { CODEX_HOME: codexHome });
    expect((await CODEX.status(ctx)).kind).toBe('not_installed');
    const outcome = await CODEX.install(ctx);
    expect(outcome.backup).toBeDefined();
    expect(readFileSync(file, 'utf8')).toBe(
      `${original}\n[mcp_servers.integr8-forms]\ncommand = "${PROGRAM}"\nargs = ["serve"]\n`,
    );
    expect((await CODEX.status(ctx)).kind).toBe('installed');
    expect((await CODEX.install(ctx)).message).toMatch(/Already set up/u);
    await CODEX.remove(ctx);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('is not found without the command or ~/.codex', async () => {
    expect((await CODEX.status(context('linux'))).kind).toBe('not_found');
  });
});

describe('Gemini CLI', () => {
  it('uses gemini mcp add --scope user when the command exists', async () => {
    const runner = new FakeRunner({ gemini: '/usr/bin/gemini' });
    await GEMINI.install(context('linux', runner));
    expect(runner.calls).toEqual([
      {
        file: '/usr/bin/gemini',
        args: ['mcp', 'add', '--scope', 'user', 'integr8-forms', PROGRAM, 'serve'],
      },
    ]);
    await GEMINI.remove(context('linux', runner));
    expect(runner.calls[1]).toEqual({
      file: '/usr/bin/gemini',
      args: ['mcp', 'remove', '--scope', 'user', 'integr8-forms'],
    });
  });
});
