import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isSea } from 'node:sea';
import { type Host, installedProgram } from '../host.js';
import { replaceProgram } from './update.js';

/**
 * The program puts a copy of itself in one fixed folder per user, and every
 * AI tool is configured with that path: the file people downloaded can then be
 * deleted or moved, and an update replaces the copy in place.
 */

export interface SelfInstall {
  /** The path every configuration uses. */
  program: string;
  /** Whether this run is the single executable (and so can copy itself). */
  executable: boolean;
  /** What happened, for the screen. */
  message: string;
  copied: boolean;
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);

function digest(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/** The installed copy's version, asked of the copy itself. */
export function installedVersion(program: string): string | undefined {
  if (!existsSync(program)) {
    return undefined;
  }
  const result = spawnSync(program, ['--version'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const version = result.stdout.trim();
  return result.status === 0 && version !== '' ? version : undefined;
}

export interface InstallSelfOptions {
  replace: boolean;
  /** Where the copy goes; Forms for AI's own place unless another program says (P43). */
  program?: string;
  /**
   * Files that must sit beside the executable, copied from beside the running
   * one into the install folder (the developer MCP server's keychain module).
   */
  companions?: readonly string[];
}

/** Copies the companion files from beside `self` into `folder`; a missing one is reported. */
function copyCompanions(self: string, folder: string, names: readonly string[]): string[] {
  const missing: string[] = [];
  for (const name of names) {
    const from = join(dirname(self), basename(name));
    const to = join(folder, basename(name));
    if (!existsSync(from)) {
      if (!existsSync(to)) {
        missing.push(name);
      }
      continue;
    }
    if (!samePath(from, to)) {
      copyFileSync(from, to);
    }
  }
  return missing;
}

export function installSelf(host: Host, options: InstallSelfOptions): SelfInstall {
  const program = options.program ?? installedProgram(host);
  const companions = options.companions ?? [];
  if (!isSea()) {
    return {
      program,
      executable: false,
      copied: false,
      message:
        'Running from source, not as the single executable: nothing is copied. Build it with `pnpm --filter @integr8/forms-ai sea` to install.',
    };
  }
  const self = process.execPath;
  if (samePath(self, program)) {
    return {
      program,
      executable: true,
      copied: false,
      message: `Running the installed copy at ${program}.`,
    };
  }
  const companionNote = () => {
    const missing = copyCompanions(self, dirname(program), companions);
    return missing.length === 0
      ? ''
      : ` ${missing.join(', ')} was not found beside the downloaded program: unpack the whole download into one folder and run it from there.`;
  };
  if (
    existsSync(program) &&
    statSync(program).size === statSync(self).size &&
    digest(program) === digest(self)
  ) {
    return {
      program,
      executable: true,
      copied: false,
      message: `Already installed at ${program}.${companionNote()}`,
    };
  }
  if (existsSync(program) && !options.replace) {
    return {
      program,
      executable: true,
      copied: false,
      message: `A different copy is installed at ${program}; it was kept.`,
    };
  }
  mkdirSync(dirname(program), { recursive: true });
  replaceProgram(program, new Uint8Array(readFileSync(self)));
  return {
    program,
    executable: true,
    copied: true,
    message: `Installed at ${program}.${companionNote()}`,
  };
}
