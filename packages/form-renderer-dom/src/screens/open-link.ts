/**
 * How an app opens a link outside itself: a file's short-lived link, a mail or
 * WhatsApp address. The desktop app hands it to the operating system, because
 * a Tauri window quietly ignores `window.open`; a browser tab needs nothing.
 */
export type LinkOpener = (url: string) => void;

/**
 * Opens a link the server is still making, such as a document's five-minute
 * file link, after a click.
 *
 * With the app's own opener, that opener gets the link once it is known. In a
 * browser the new tab is opened at the click, before the wait, and pointed at
 * the link afterwards: a tab opened only after a network round trip has lost
 * the click and is often stopped as a pop-up. A link that never comes closes
 * the empty tab again.
 */
export async function openPendingLink(
  link: Promise<string | undefined>,
  opener: LinkOpener | undefined,
): Promise<void> {
  if (opener !== undefined) {
    const url = await link;
    if (url !== undefined) {
      opener(url);
    }
    return;
  }
  const tab = window.open('', '_blank');
  if (tab !== null) {
    // What `noopener` would do, which cannot be asked for here: the opened
    // page must not reach back into this one.
    tab.opener = null;
  }
  let url: string | undefined;
  try {
    url = await link;
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (url === undefined) {
    tab?.close();
  } else if (tab === null) {
    window.open(url, '_blank', 'noopener');
  } else {
    tab.location.href = url;
  }
}

/** Opens a link that is already known, such as a `mailto:` address. */
export function openLink(url: string, opener: LinkOpener | undefined): void {
  if (opener === undefined) {
    window.open(url, '_blank', 'noopener');
  } else {
    opener(url);
  }
}
