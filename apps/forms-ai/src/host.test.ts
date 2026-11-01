import { describe, expect, it } from 'vitest';
import { defaultOutputDir, type Host, installDir, installedProgram, settingsFile } from './host.js';
import { browserCandidates, findBrowser } from './preview/browser.js';
import { claudeDesktopFolders, codexFile, vscodeUserFolder } from './setup/tools.js';

const windows: Host = {
  platform: 'win32',
  arch: 'x64',
  home: 'C:\\Users\\Mina Leon',
  env: {
    LOCALAPPDATA: 'C:\\Users\\Mina Leon\\AppData\\Local',
    APPDATA: 'C:\\Users\\Mina Leon\\AppData\\Roaming',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  },
};
const mac: Host = { platform: 'darwin', arch: 'arm64', home: '/Users/mina', env: {} };
const linux: Host = {
  platform: 'linux',
  arch: 'x64',
  home: '/home/mina',
  env: { PATH: '/usr/bin:/bin' },
};

describe('where things go', () => {
  it('installs the program in one fixed folder per user', () => {
    expect(installedProgram(windows)).toBe(
      'C:\\Users\\Mina Leon\\AppData\\Local\\Integr8\\forms-ai\\integr8-forms-ai.exe',
    );
    expect(installedProgram(mac)).toBe(
      '/Users/mina/Library/Application Support/Integr8/forms-ai/integr8-forms-ai',
    );
    expect(installedProgram(linux)).toBe(
      '/home/mina/.local/share/integr8/forms-ai/integr8-forms-ai',
    );
    expect(installDir({ ...linux, env: { XDG_DATA_HOME: '/data' } })).toBe(
      '/data/integr8/forms-ai',
    );
    expect(installDir({ ...linux, env: { INTEGR8_FORMS_HOME: '/tmp/x' } })).toBe('/tmp/x');
    expect(settingsFile(mac)).toBe(
      '/Users/mina/Library/Application Support/Integr8/forms-ai/settings.json',
    );
  });

  it('saves packages in Documents/Integr8 forms by default', () => {
    expect(defaultOutputDir(windows)).toBe('C:\\Users\\Mina Leon\\Documents\\Integr8 forms');
    expect(defaultOutputDir(mac)).toBe('/Users/mina/Documents/Integr8 forms');
  });

  it('knows each AI tool’s user-level settings on Windows and macOS', () => {
    expect(claudeDesktopFolders(windows)[0]).toBe('C:\\Users\\Mina Leon\\AppData\\Roaming\\Claude');
    expect(claudeDesktopFolders(mac)).toEqual(['/Users/mina/Library/Application Support/Claude']);
    expect(vscodeUserFolder(windows)).toBe('C:\\Users\\Mina Leon\\AppData\\Roaming\\Code\\User');
    expect(vscodeUserFolder(linux)).toBe('/home/mina/.config/Code/User');
    expect(codexFile(windows)).toBe('C:\\Users\\Mina Leon\\.codex\\config.toml');
  });

  it('looks for Chrome, Edge and Chromium where they are installed', () => {
    expect(browserCandidates(windows)).toContain(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    );
    expect(browserCandidates(windows)).toContain(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
    expect(browserCandidates(mac)).toContain(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(browserCandidates(mac)).toContain(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
    expect(browserCandidates(linux)).toContain('/usr/bin/google-chrome');
    expect(browserCandidates(linux)).toContain('/usr/bin/chromium');
    const edgeOnly = (path: string) => path.endsWith('msedge.exe');
    expect(findBrowser(windows, edgeOnly)?.path).toMatch(/msedge\.exe$/u);
    expect(findBrowser(windows, () => false)).toBeUndefined();
    expect(
      findBrowser({ ...linux, env: { INTEGR8_FORMS_BROWSER: '/opt/chrome' } }, () => true),
    ).toEqual({
      path: '/opt/chrome',
      source: 'environment',
    });
  });
});
