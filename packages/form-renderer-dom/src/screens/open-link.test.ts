import { afterEach, describe, expect, it, vi } from 'vitest';
import { openLink, openPendingLink } from './open-link.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('opening a link the server is still making', () => {
  it('gives the app’s own opener the link once it is known', async () => {
    const open = vi.spyOn(window, 'open');
    const opener = vi.fn();
    await openPendingLink(Promise.resolve('https://files.example/a.pdf'), opener);
    expect(opener).toHaveBeenCalledWith('https://files.example/a.pdf');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the browser tab at the click and points it at the link afterwards', async () => {
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    let resolve: (url: string) => void = () => undefined;
    const pending = openPendingLink(
      new Promise<string>((done) => {
        resolve = done;
      }),
      undefined,
    );
    // The tab exists before the link does.
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    resolve('https://files.example/a.pdf');
    await pending;
    expect(tab.location.href).toBe('https://files.example/a.pdf');
  });

  it('closes the empty tab when no link comes', async () => {
    const tab = { opener: null, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    await openPendingLink(Promise.resolve(undefined), undefined);
    expect(tab.close).toHaveBeenCalled();
    await expect(openPendingLink(Promise.reject(new Error('gone')), undefined)).rejects.toThrow(
      'gone',
    );
    expect(tab.close).toHaveBeenCalledTimes(2);
  });

  it('falls back to opening the link itself when the tab was blocked', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openPendingLink(Promise.resolve('https://files.example/a.pdf'), undefined);
    expect(open).toHaveBeenLastCalledWith('https://files.example/a.pdf', '_blank', 'noopener');
  });

  it('opens a known address with the opener when there is one', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const opener = vi.fn();
    openLink('mailto:someone@example.com', opener);
    expect(opener).toHaveBeenCalledWith('mailto:someone@example.com');
    openLink('mailto:someone@example.com', undefined);
    expect(open).toHaveBeenCalledWith('mailto:someone@example.com', '_blank', 'noopener');
  });
});
