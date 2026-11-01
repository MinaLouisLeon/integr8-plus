import { accessSync, constants, statSync } from 'node:fs';
import { delimiter as hostDelimiter } from 'node:path';
import { type Host, joinFor } from '../host.js';

/**
 * Finds a Chromium-based browser already on the machine — Chrome, Edge or
 * Chromium — to print previews with. Nothing is downloaded: a machine without
 * one simply gets no previews (decision 15), and the tool says so.
 *
 * `INTEGR8_FORMS_BROWSER` names one explicitly.
 */

export interface FoundBrowser {
  path: string;
  /** How it was found: the environment, or a standard install location. */
  source: 'environment' | 'standard';
}

function runnable(path: string, host: Host): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false;
    }
    if (host.platform !== 'win32') {
      accessSync(path, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Every place a browser is normally installed, most wanted first. */
export function browserCandidates(host: Host): string[] {
  switch (host.platform) {
    case 'win32': {
      const roots = [
        host.env.PROGRAMFILES ?? 'C:\\Program Files',
        host.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        host.env.LOCALAPPDATA ?? joinFor(host, host.home, 'AppData', 'Local'),
      ];
      const apps = [
        ['Google', 'Chrome', 'Application', 'chrome.exe'],
        ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
        ['Chromium', 'Application', 'chrome.exe'],
        ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ];
      return apps.flatMap((parts) => roots.map((root) => joinFor(host, root, ...parts)));
    }
    case 'darwin': {
      const apps = [
        'Google Chrome.app/Contents/MacOS/Google Chrome',
        'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        'Chromium.app/Contents/MacOS/Chromium',
        'Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
      return apps.flatMap((app) => [
        `/Applications/${app}`,
        joinFor(host, host.home, 'Applications', app),
      ]);
    }
    default: {
      const names = [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
        'microsoft-edge',
        'microsoft-edge-stable',
        'brave-browser',
      ];
      const path = (host.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')
        .split(hostDelimiter)
        .filter((part) => part !== '');
      return [
        ...names.flatMap((name) => path.map((folder) => joinFor(host, folder, name))),
        '/opt/google/chrome/chrome',
        '/opt/microsoft/msedge/msedge',
        '/snap/bin/chromium',
      ];
    }
  }
}

export function findBrowser(
  host: Host,
  exists: (path: string) => boolean = (path) => runnable(path, host),
): FoundBrowser | undefined {
  const named = host.env.INTEGR8_FORMS_BROWSER;
  if (named !== undefined && named !== '') {
    return exists(named) ? { path: named, source: 'environment' } : undefined;
  }
  const found = browserCandidates(host).find((candidate) => exists(candidate));
  return found === undefined ? undefined : { path: found, source: 'standard' };
}
