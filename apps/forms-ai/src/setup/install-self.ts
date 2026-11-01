import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

export function installSelf(host: Host, options: { replace: boolean }): SelfInstall {
  const program = installedProgram(host);
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
  if (
    existsSync(program) &&
    statSync(program).size === statSync(self).size &&
    digest(program) === digest(self)
  ) {
    return {
      program,
      executable: true,
      copied: false,
      message: `Already installed at ${program}.`,
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
  return { program, executable: true, copied: true, message: `Installed at ${program}.` };
}
