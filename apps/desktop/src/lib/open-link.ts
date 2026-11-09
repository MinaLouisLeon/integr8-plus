import type { LinkOpener } from '@integr8/form-renderer-dom/screens';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from './platform';

/**
 * How this app opens a link outside itself: a PDF to view or save, a receipt,
 * a mail or WhatsApp address.
 *
 * The Tauri window opens no windows of its own, so `window.open` and a link
 * with `target="_blank"` quietly do nothing there. The operating system opens
 * the link instead: the default browser shows or saves a file, the mail app
 * takes a `mailto:`. A browser tab needs nothing, so it gets `undefined` and
 * the shared screens open their own tabs.
 */
export const DESKTOP_LINK_OPENER: LinkOpener | undefined = isTauri()
  ? (url) => void openUrl(url).catch(() => undefined)
  : undefined;

/** Addresses handed to the operating system; anything else stays in the window. */
const OUTSIDE = /^(https?:|mailto:|tel:)/iu;

/**
 * In the Tauri window, a click on a link meant for a new tab (an open or
 * download link on a photo, say) goes to the operating system as well.
 * Links to the app's own pages, and saved files made in the page (`blob:`),
 * are left alone. Returns the function that removes the listener.
 */
export function routeOutsideLinks(target: Document = document): () => void {
  if (DESKTOP_LINK_OPENER === undefined) {
    return () => undefined;
  }
  const opener = DESKTOP_LINK_OPENER;
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    const link = (event.target as Element | null)?.closest?.('a[href]');
    if (!(link instanceof HTMLAnchorElement)) {
      return;
    }
    const outside = link.target === '_blank' || link.hasAttribute('download');
    if (!outside || !OUTSIDE.test(link.href)) {
      return;
    }
    event.preventDefault();
    opener(link.href);
  };
  target.addEventListener('click', onClick);
  return () => target.removeEventListener('click', onClick);
}
