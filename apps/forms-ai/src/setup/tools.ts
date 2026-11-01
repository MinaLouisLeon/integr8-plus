import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { type Host, joinFor, localAppData, roamingAppData } from '../host.js';
import { SERVER_NAME } from '../version.js';
import { getEntry, removeEntry, setEntry } from './jsonc.js';
import type { Runner } from './runner.js';
import { getTomlServer, removeTomlTable, setTomlTable } from './toml.js';

/**
 * The AI tools the installer connects the server to (decision 15), one small
 * adapter each. A tool with its own command for adding MCP servers is set up
 * with it (Claude Code, Codex, Gemini CLI); the others get their settings
 * file edited — backed up first, with a timestamp, and only the
 * `integr8-forms` entry touched (see `jsonc.ts`, `toml.ts`). Every entry runs
 * the installed program with `serve`; installing twice changes nothing.
 */

export type ToolId =
  'claude-code' | 'codex' | 'claude-desktop' | 'cursor' | 'vscode' | 'windsurf' | 'gemini';

export interface ToolContext {
  host: Host;
  /** The installed program every configuration runs. */
  program: string;
  runner: Runner;
  now: () => Date;
}

export type ToolState =
  | { kind: 'not_found' }
  | { kind: 'not_installed'; where: string }
  | { kind: 'installed'; where: string }
  /** Set up, but running another copy of the program (an older install, a download folder). */
  | { kind: 'other_path'; where: string; command: string };

export interface Outcome {
  ok: boolean;
  message: string;
  /** The backup made before a file was changed. */
  backup?: string;
}

export interface ToolAdapter {
  id: ToolId;
  name: string;
  status(ctx: ToolContext): Promise<ToolState>;
  install(ctx: ToolContext): Promise<Outcome>;
  remove(ctx: ToolContext): Promise<Outcome>;
}

const SERVE = ['serve'] as const;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `<file>.integr8-backup-20261101-093000`, beside the file. */
export function backupFile(path: string, now: Date): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  let backup = `${path}.integr8-backup-${stamp}`;
  for (let n = 2; existsSync(backup); n += 1) {
    backup = `${path}.integr8-backup-${stamp}-${String(n)}`;
  }
  copyFileSync(path, backup);
  return backup;
}

/** Writes beside the file and moves it over, so a crash never leaves half a settings file. */
function writeAtomically(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.integr8-tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** Whether an entry runs this program with `serve`. */
function stateOf(entry: unknown, program: string, where: string): ToolState {
  if (typeof entry !== 'object' || entry === null) {
    return { kind: 'not_installed', where };
  }
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const sameArgs = Array.isArray(args) && args.length === 1 && args[0] === 'serve';
  if (command === program && sameArgs) {
    return { kind: 'installed', where };
  }
  return { kind: 'other_path', where, command: typeof command === 'string' ? command : '?' };
}

// ---------------------------------------------------------------------------
// Tools configured by a JSON settings file
// ---------------------------------------------------------------------------

interface JsonTool {
  id: ToolId;
  name: string;
  /** The tool is there when one of these folders exists. */
  detect(host: Host): string[];
  /** Its user-level settings file (the first of several candidates that exists, else the first). */
  files(host: Host): string[];
  section: string;
  entry(program: string): Record<string, unknown>;
}

function jsonAdapter(tool: JsonTool): ToolAdapter {
  const fileFor = (host: Host) => {
    const files = tool.files(host);
    return (
      files.find((file) => existsSync(file)) ??
      files.find((file) => isDirectory(dirname(file))) ??
      files[0] ??
      ''
    );
  };
  const found = (host: Host) => tool.detect(host).some(isDirectory);
  return {
    id: tool.id,
    name: tool.name,
    status(ctx) {
      if (!found(ctx.host)) {
        return Promise.resolve({ kind: 'not_found' });
      }
      const file = fileFor(ctx.host);
      const text = readText(file) ?? '';
      try {
        return Promise.resolve(
          stateOf(getEntry(text, tool.section, SERVER_NAME), ctx.program, file),
        );
      } catch {
        return Promise.resolve({ kind: 'not_installed', where: file });
      }
    },
    install(ctx) {
      const file = fileFor(ctx.host);
      const before = readText(file) ?? '';
      let after: string;
      try {
        after = setEntry(before, tool.section, SERVER_NAME, tool.entry(ctx.program));
      } catch (error) {
        return Promise.resolve({
          ok: false,
          message: `${file} could not be read as JSON (${error instanceof Error ? error.message : String(error)}); it was not changed.`,
        });
      }
      if (after === before) {
        return Promise.resolve({ ok: true, message: `Already set up in ${file}.` });
      }
      const backup = backupFile(file, ctx.now());
      writeAtomically(file, after);
      return Promise.resolve({
        ok: true,
        message: `Added to ${file}.`,
        ...(backup === undefined ? {} : { backup }),
      });
    },
    remove(ctx) {
      const file = fileFor(ctx.host);
      const before = readText(file);
      if (before === undefined) {
        return Promise.resolve({ ok: true, message: 'Nothing to remove.' });
      }
      let after: string;
      try {
        after = removeEntry(before, tool.section, SERVER_NAME);
      } catch (error) {
        return Promise.resolve({
          ok: false,
          message: `${file} could not be read as JSON (${error instanceof Error ? error.message : String(error)}); it was not changed.`,
        });
      }
      if (after === before) {
        return Promise.resolve({ ok: true, message: 'Nothing to remove.' });
      }
      const backup = backupFile(file, ctx.now());
      writeAtomically(file, after);
      return Promise.resolve({
        ok: true,
        message: `Removed from ${file}.`,
        ...(backup === undefined ? {} : { backup }),
      });
    },
  };
}

/** Where Claude Desktop keeps its settings. On Windows the Store (MSIX) build keeps its own copy. */
export function claudeDesktopFolders(host: Host): string[] {
  switch (host.platform) {
    case 'win32': {
      const folders = [joinFor(host, roamingAppData(host), 'Claude')];
      const packages = joinFor(host, localAppData(host), 'Packages');
      try {
        for (const name of readdirSync(packages)) {
          if (/claude/iu.test(name)) {
            folders.push(joinFor(host, packages, name, 'LocalCache', 'Roaming', 'Claude'));
          }
        }
      } catch {
        // No Store apps.
      }
      return folders;
    }
    case 'darwin':
      return [joinFor(host, host.home, 'Library', 'Application Support', 'Claude')];
    default:
      return [
        joinFor(host, host.env.XDG_CONFIG_HOME ?? joinFor(host, host.home, '.config'), 'Claude'),
      ];
  }
}

/** VS Code's user folder, where its user-level `mcp.json` lives. */
export function vscodeUserFolder(host: Host): string {
  switch (host.platform) {
    case 'win32':
      return joinFor(host, roamingAppData(host), 'Code', 'User');
    case 'darwin':
      return joinFor(host, host.home, 'Library', 'Application Support', 'Code', 'User');
    default:
      return joinFor(
        host,
        host.env.XDG_CONFIG_HOME ?? joinFor(host, host.home, '.config'),
        'Code',
        'User',
      );
  }
}

const commandEntry = (program: string) => ({ command: program, args: [...SERVE] });

export const CLAUDE_DESKTOP = jsonAdapter({
  id: 'claude-desktop',
  name: 'Claude Desktop',
  detect: claudeDesktopFolders,
  files: (host) =>
    claudeDesktopFolders(host).map((folder) => joinFor(host, folder, 'claude_desktop_config.json')),
  section: 'mcpServers',
  entry: commandEntry,
});

export const CURSOR = jsonAdapter({
  id: 'cursor',
  name: 'Cursor',
  detect: (host) => [joinFor(host, host.home, '.cursor')],
  files: (host) => [joinFor(host, host.home, '.cursor', 'mcp.json')],
  section: 'mcpServers',
  entry: commandEntry,
});

export const VSCODE = jsonAdapter({
  id: 'vscode',
  name: 'VS Code (GitHub Copilot)',
  detect: (host) => [vscodeUserFolder(host)],
  files: (host) => [joinFor(host, vscodeUserFolder(host), 'mcp.json')],
  section: 'servers',
  entry: (program) => ({ type: 'stdio', command: program, args: [...SERVE] }),
});

export const WINDSURF = jsonAdapter({
  id: 'windsurf',
  name: 'Windsurf',
  detect: (host) => [joinFor(host, host.home, '.codeium', 'windsurf')],
  files: (host) => [joinFor(host, host.home, '.codeium', 'windsurf', 'mcp_config.json')],
  section: 'mcpServers',
  entry: commandEntry,
});

/** Gemini CLI's settings file, for reading its state and when its command is not on PATH. */
const GEMINI_FILE = jsonAdapter({
  id: 'gemini',
  name: 'Gemini CLI',
  detect: (host) => [joinFor(host, host.home, '.gemini')],
  files: (host) => [joinFor(host, host.home, '.gemini', 'settings.json')],
  section: 'mcpServers',
  entry: commandEntry,
});

// ---------------------------------------------------------------------------
// Tools with their own command
// ---------------------------------------------------------------------------

const output = (result: { stdout: string; stderr: string }) =>
  `${result.stderr.trim()} ${result.stdout.trim()}`.trim().split('\n').slice(-2).join(' ');

/** Claude Code: `claude mcp add --scope user`, which writes `mcpServers` in ~/.claude.json. */
export const CLAUDE_CODE: ToolAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  status(ctx) {
    if (ctx.runner.which('claude') === undefined) {
      return Promise.resolve({ kind: 'not_found' });
    }
    const folder = ctx.host.env.CLAUDE_CONFIG_DIR;
    const file = joinFor(
      ctx.host,
      folder !== undefined && folder !== '' ? folder : ctx.host.home,
      '.claude.json',
    );
    try {
      return Promise.resolve(
        stateOf(
          getEntry(readText(file) ?? '', 'mcpServers', SERVER_NAME),
          ctx.program,
          'claude (user scope)',
        ),
      );
    } catch {
      return Promise.resolve({ kind: 'not_installed', where: 'claude (user scope)' });
    }
  },
  async install(ctx) {
    const claude = ctx.runner.which('claude');
    if (claude === undefined) {
      return { ok: false, message: 'The claude command was not found.' };
    }
    // `add` refuses a name that exists, so an old entry is removed first.
    await ctx.runner.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    const added = await ctx.runner.run(claude, [
      'mcp',
      'add',
      '--scope',
      'user',
      SERVER_NAME,
      '--',
      ctx.program,
      ...SERVE,
    ]);
    return added.code === 0
      ? { ok: true, message: 'Added with claude mcp add --scope user.' }
      : { ok: false, message: `claude mcp add failed: ${output(added)}` };
  },
  async remove(ctx) {
    const claude = ctx.runner.which('claude');
    if (claude === undefined) {
      return { ok: false, message: 'The claude command was not found.' };
    }
    const removed = await ctx.runner.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    return removed.code === 0
      ? { ok: true, message: 'Removed with claude mcp remove.' }
      : { ok: true, message: 'Nothing to remove.' };
  },
};

const CODEX_TABLE = ['mcp_servers', SERVER_NAME];

export function codexFile(host: Host): string {
  const home = host.env.CODEX_HOME;
  return joinFor(
    host,
    home !== undefined && home !== '' ? home : joinFor(host, host.home, '.codex'),
    'config.toml',
  );
}

/** Codex: `codex mcp add`, else its `config.toml` table `[mcp_servers.integr8-forms]`. */
export const CODEX: ToolAdapter = {
  id: 'codex',
  name: 'Codex',
  status(ctx) {
    const file = codexFile(ctx.host);
    if (ctx.runner.which('codex') === undefined && !isDirectory(dirname(file))) {
      return Promise.resolve({ kind: 'not_found' });
    }
    return Promise.resolve(
      stateOf(getTomlServer(readText(file) ?? '', CODEX_TABLE), ctx.program, file),
    );
  },
  async install(ctx) {
    const codex = ctx.runner.which('codex');
    const file = codexFile(ctx.host);
    if (codex !== undefined) {
      if (
        stateOf(getTomlServer(readText(file) ?? '', CODEX_TABLE), ctx.program, file).kind ===
        'installed'
      ) {
        return { ok: true, message: 'Already set up.' };
      }
      await ctx.runner.run(codex, ['mcp', 'remove', SERVER_NAME]);
      const added = await ctx.runner.run(codex, [
        'mcp',
        'add',
        SERVER_NAME,
        '--',
        ctx.program,
        ...SERVE,
      ]);
      return added.code === 0
        ? { ok: true, message: 'Added with codex mcp add.' }
        : { ok: false, message: `codex mcp add failed: ${output(added)}` };
    }
    const before = readText(file) ?? '';
    const after = setTomlTable(before, CODEX_TABLE, { command: ctx.program, args: [...SERVE] });
    if (after === before) {
      return { ok: true, message: `Already set up in ${file}.` };
    }
    const backup = backupFile(file, ctx.now());
    writeAtomically(file, after);
    return { ok: true, message: `Added to ${file}.`, ...(backup === undefined ? {} : { backup }) };
  },
  async remove(ctx) {
    const codex = ctx.runner.which('codex');
    const file = codexFile(ctx.host);
    if (codex !== undefined) {
      const removed = await ctx.runner.run(codex, ['mcp', 'remove', SERVER_NAME]);
      return {
        ok: true,
        message: removed.code === 0 ? 'Removed with codex mcp remove.' : 'Nothing to remove.',
      };
    }
    const before = readText(file);
    if (before === undefined) {
      return { ok: true, message: 'Nothing to remove.' };
    }
    const after = removeTomlTable(before, CODEX_TABLE);
    if (after === before) {
      return { ok: true, message: 'Nothing to remove.' };
    }
    const backup = backupFile(file, ctx.now());
    writeAtomically(file, after);
    return {
      ok: true,
      message: `Removed from ${file}.`,
      ...(backup === undefined ? {} : { backup }),
    };
  },
};

/** Gemini CLI: `gemini mcp add --scope user`, else `mcpServers` in ~/.gemini/settings.json. */
export const GEMINI: ToolAdapter = {
  id: 'gemini',
  name: 'Gemini CLI',
  async status(ctx) {
    if (ctx.runner.which('gemini') === undefined) {
      return GEMINI_FILE.status(ctx);
    }
    const state = await GEMINI_FILE.status(ctx);
    return state.kind === 'not_found'
      ? {
          kind: 'not_installed',
          where: joinFor(ctx.host, ctx.host.home, '.gemini', 'settings.json'),
        }
      : state;
  },
  async install(ctx) {
    const gemini = ctx.runner.which('gemini');
    if (gemini === undefined) {
      return GEMINI_FILE.install(ctx);
    }
    if ((await GEMINI_FILE.status(ctx)).kind === 'installed') {
      return { ok: true, message: 'Already set up.' };
    }
    // `add` replaces an entry of the same name.
    const added = await ctx.runner.run(gemini, [
      'mcp',
      'add',
      '--scope',
      'user',
      SERVER_NAME,
      ctx.program,
      ...SERVE,
    ]);
    return added.code === 0
      ? { ok: true, message: 'Added with gemini mcp add --scope user.' }
      : { ok: false, message: `gemini mcp add failed: ${output(added)}` };
  },
  async remove(ctx) {
    const gemini = ctx.runner.which('gemini');
    if (gemini === undefined) {
      return GEMINI_FILE.remove(ctx);
    }
    const removed = await ctx.runner.run(gemini, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
    return {
      ok: true,
      message: removed.code === 0 ? 'Removed with gemini mcp remove.' : 'Nothing to remove.',
    };
  },
};

/** In the order the installer lists them. */
export const TOOLS: readonly ToolAdapter[] = [
  CLAUDE_CODE,
  CODEX,
  CLAUDE_DESKTOP,
  CURSOR,
  VSCODE,
  WINDSURF,
  GEMINI,
];
