import { afterEach, describe, expect, it } from 'vitest';
import { desktopVoiceInput, operatingSystem } from './voice';

/**
 * The desktop bundle runs in a browser tab and in the Tauri window. The tab
 * keeps the browser's recogniser; the window, which has none, points the person
 * at the operating system's dictation, and only where there is one.
 */

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('where a spoken question comes from', () => {
  it('says nothing in a browser tab, so the browser’s own recogniser is used', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(desktopVoiceInput({ platform: 'Win32' })).toBeUndefined();
  });

  it('names Windows dictation in the Tauri window on Windows', () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(desktopVoiceInput({ userAgentData: { platform: 'Windows' } })).toEqual({
      kind: 'dictation',
      os: 'windows',
    });
    expect(desktopVoiceInput({ platform: 'Win32' })).toEqual({ kind: 'dictation', os: 'windows' });
  });

  it('names macOS dictation in the Tauri window on a Mac', () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(desktopVoiceInput({ platform: 'MacIntel' })).toEqual({ kind: 'dictation', os: 'macos' });
  });

  it('offers no microphone on Linux, which has no standard dictation', () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(
      desktopVoiceInput({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux)' }),
    ).toEqual({ kind: 'none' });
    expect(desktopVoiceInput({})).toEqual({ kind: 'none' });
  });

  it('reads the platform from whichever field the web view fills', () => {
    expect(operatingSystem({ userAgentData: { platform: 'macOS' } })).toBe('macos');
    expect(operatingSystem({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(
      'windows',
    );
    expect(operatingSystem({})).toBe('other');
  });
});
