import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from '~/components/update-banner';
import { findUpdate, installerRestartsApp } from './updates';

/**
 * The desktop app asking for its own update (P20). The plugin itself is
 * Tauri's; what is ours is that a failed check is silent and that the person
 * is asked before the window closes.
 */

describe('looking for an update', () => {
  it('never asks from a browser tab', async () => {
    const check = vi.fn();
    expect(await findUpdate({ check, inTauri: false })).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it('reports the waiting version and installs it on request', async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve());
    const update = await findUpdate({
      inTauri: true,
      check: () => Promise.resolve({ version: '1.2.3', downloadAndInstall }),
    });
    expect(update?.version).toBe('1.2.3');
    await update?.install();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
  });

  it('treats no update and an unreachable feed alike: nothing to show', async () => {
    expect(await findUpdate({ inTauri: true, check: () => Promise.resolve(null) })).toBeUndefined();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(
      await findUpdate({ inTauri: true, check: () => Promise.reject(new Error('offline')) }),
    ).toBeUndefined();
    warn.mockRestore();
  });

  it('knows the Windows installer reopens the app', () => {
    expect(installerRestartsApp('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(installerRestartsApp('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(false);
  });
});

describe('the update strip', () => {
  const render = (locale: 'en' | 'ar') =>
    renderToStaticMarkup(
      <I18nextProvider i18n={createI18n({ locale })}>
        <UpdateBanner initial={{ version: '1.2.3', install: () => Promise.resolve() }} />
      </I18nextProvider>,
    );

  it('names the version and offers to install it, in both languages', () => {
    const en = render('en');
    expect(en).toContain('Version 1.2.3 of this app is ready.');
    expect(en).toContain('Install now');
    expect(en).toContain('Later');
    expect(render('ar')).toContain('الإصدار 1.2.3');
  });

  it('shows nothing until an update is found', () => {
    expect(
      renderToStaticMarkup(
        <I18nextProvider i18n={createI18n({ locale: 'en' })}>
          <UpdateBanner />
        </I18nextProvider>,
      ),
    ).toBe('');
  });
});
