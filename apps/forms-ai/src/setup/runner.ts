import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Host } from '../host.js';

/**
 * Finding and running other programs (the AI tools' own command-line tools),
 * behind an interface so the adapters' tests run against a fake.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Runner {
  /** The full path of a program on PATH, or undefined. */
  which(name: string): string | undefined;
  run(file: string, args: readonly string[], timeoutMs?: number): Promise<RunResult>;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * One argument for cmd.exe, quoted with any quote doubled. The arguments are
 * the tool's name, its own path and "serve", none of which holds a quote or
 * a `%` in any real installation.
 */
function cmdQuote(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

export function systemRunner(host: Host): Runner {
  const windows = host.platform === 'win32';
  return {
    which(name) {
      const path = host.env.PATH ?? host.env.Path ?? '';
      const folders = path.split(windows ? ';' : ':').filter((folder) => folder !== '');
      const extensions = windows
        ? (host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
        : [''];
      for (const folder of folders) {
        for (const extension of extensions) {
          const candidate = (windows ? win32 : posix).join(
            folder,
            `${name}${extension.toLowerCase()}`,
          );
          if (isFile(candidate)) {
            return candidate;
          }
        }
      }
      return undefined;
    },
    run(file, args, timeoutMs = 60_000) {
      return new Promise((resolve) => {
        // Windows will not start a .cmd or .bat directly (npm installs CLIs as
        // .cmd files); cmd.exe runs it, with every argument quoted.
        const viaCmd = windows && /\.(cmd|bat)$/iu.test(file);
        const child = viaCmd
          ? spawn(
              host.env.ComSpec ?? 'cmd.exe',
              ['/d', '/s', '/c', `"${[file, ...args].map(cmdQuote).join(' ')}"`],
              {
                windowsVerbatimArguments: true,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            )
          : spawn(file, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        const timer = setTimeout(() => {
          child.kill();
        }, timeoutMs);
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        });
      });
    },
  };
}
