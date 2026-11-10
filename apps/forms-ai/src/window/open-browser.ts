import { spawn } from 'node:child_process';
import type { Host } from '../host.js';

/**
 * Opens an address in the person's default browser. Windows goes through
 * the URL protocol handler (what `start` does, without a shell between, so
 * nothing in the address is ever read as a command), macOS through `open`,
 * Linux through `xdg-open`. The tools take an `OpenUrl`, so tests pass one
 * that opens nothing.
 */

export type OpenUrl = (url: string) => Promise<boolean>;

export function openCommand(host: Pick<Host, 'platform'>, url: string): [string, string[]] {
  switch (host.platform) {
    case 'win32':
      return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
    case 'darwin':
      return ['open', [url]];
    default:
      return ['xdg-open', [url]];
  }
}

export function systemOpener(host: Pick<Host, 'platform'>): OpenUrl {
  return (url) =>
    new Promise((resolve) => {
      if (!/^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]+$/u.test(url)) {
        resolve(false);
        return;
      }
      const [command, args] = openCommand(host, url);
      try {
        const child = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('error', () => {
          resolve(false);
        });
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
}
