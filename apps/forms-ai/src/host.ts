import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { PROGRAM_NAME } from './version.js';

/**
 * The machine the tool runs on, as one value: the operating system, the home
 * folder and the environment. Everything that picks a path takes a `Host`
 * rather than reading `process` itself, so the tests can be a Windows user,
 * a Mac user and a Linux user on any machine.
 */
export interface Host {
  platform: NodeJS.Platform;
  arch: string;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export function currentHost(): Host {
  return { platform: process.platform, arch: process.arch, home: homedir(), env: process.env };
}

/** `path.join` for the host's own operating system, not the one running the tests. */
export function joinFor(host: Pick<Host, 'platform'>, ...parts: string[]): string {
  return host.platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/** `%LOCALAPPDATA%`, or where Windows keeps it by default. */
export function localAppData(host: Host): string {
  return host.env.LOCALAPPDATA ?? win32.join(host.home, 'AppData', 'Local');
}

/** `%APPDATA%` (roaming), or where Windows keeps it by default. */
export function roamingAppData(host: Host): string {
  return host.env.APPDATA ?? win32.join(host.home, 'AppData', 'Roaming');
}

/**
 * Where the tool lives once installed: one fixed folder per user, so every
 * AI tool's configuration names the same path and an update replaces the
 * file in place. `INTEGR8_FORMS_HOME` moves it (tests, and anyone who must).
 */
export function installDir(host: Host): string {
  const override = host.env.INTEGR8_FORMS_HOME;
  if (override !== undefined && override !== '') {
    return override;
  }
  switch (host.platform) {
    case 'win32':
      return win32.join(localAppData(host), 'Integr8', 'forms-ai');
    case 'darwin':
      return posix.join(host.home, 'Library', 'Application Support', 'Integr8', 'forms-ai');
    default: {
      const data = host.env.XDG_DATA_HOME;
      const base = data?.startsWith('/') === true ? data : posix.join(host.home, '.local', 'share');
      return posix.join(base, 'integr8', 'forms-ai');
    }
  }
}

/** The installed program's full path. */
export function installedProgram(host: Host): string {
  return joinFor(
    host,
    installDir(host),
    host.platform === 'win32' ? `${PROGRAM_NAME}.exe` : PROGRAM_NAME,
  );
}

/** The tool's own settings (the output folder), beside the program. */
export function settingsFile(host: Host): string {
  return joinFor(host, installDir(host), 'settings.json');
}

/**
 * The user's Documents folder. Linux names it in `~/.config/user-dirs.dirs`
 * (and in the user's language); everywhere else it is `Documents` in the
 * home folder, which is where Windows and macOS keep it unless moved.
 */
export function documentsDir(host: Host): string {
  if (host.platform === 'linux') {
    const file = posix.join(
      host.env.XDG_CONFIG_HOME ?? posix.join(host.home, '.config'),
      'user-dirs.dirs',
    );
    try {
      if (existsSync(file)) {
        const match = /^XDG_DOCUMENTS_DIR="([^"]+)"/mu.exec(readFileSync(file, 'utf8'));
        if (match?.[1] !== undefined) {
          const named = match[1].replace(/^\$HOME/u, host.home);
          if (named.startsWith('/') && named !== host.home) {
            return named;
          }
        }
      }
    } catch {
      // An unreadable file is the same as none.
    }
  }
  return joinFor(host, host.home, 'Documents');
}

/** Where packages are saved unless the user chose a folder. */
export function defaultOutputDir(host: Host): string {
  return joinFor(host, documentsDir(host), 'Integr8 forms');
}

/** The scratch folder for previews and opened packages. */
export function workDir(tmp: string): string {
  return join(tmp, 'integr8-forms-ai');
}
