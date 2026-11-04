import type { AppRelease, DesktopUpdateFeed, FormsAiRelease } from './desktop-updates';

/**
 * What the server found for one app's downloads, for a page to show. Shared
 * by the public `/download` page (a company's apps) and the dashboard's staff
 * Downloads page (the staff app and Integr8 Forms for AI). Never throws: a
 * page shows what it can, and "cannot be listed right now" is an answer.
 */

export type ReleaseLookup =
  { status: 'found'; release: AppRelease } | { status: 'none' } | { status: 'unavailable' };

/** Integr8 Forms for AI, from the newest staff release that carries it. */
export type FormsAiLookup =
  { status: 'found'; release: FormsAiRelease } | { status: 'none' } | { status: 'unavailable' };

/** One app's newest installable release. */
export async function lookupInstallers(
  feed: DesktopUpdateFeed | undefined,
  app: string,
): Promise<ReleaseLookup> {
  if (feed === undefined) {
    // No repository configured: nothing has been published from here.
    return { status: 'none' };
  }
  try {
    const release = await feed.installers(app);
    return release === undefined ? { status: 'none' } : { status: 'found', release };
  } catch (error) {
    console.error('downloads', app, error);
    return { status: 'unavailable' };
  }
}

/** Integr8 Forms for AI's program files, from the staff releases. */
export async function lookupFormsAi(feed: DesktopUpdateFeed | undefined): Promise<FormsAiLookup> {
  if (feed === undefined) {
    return { status: 'none' };
  }
  try {
    const release = await feed.formsAi();
    return release === undefined ? { status: 'none' } : { status: 'found', release };
  } catch (error) {
    console.error('downloads', 'forms-ai', error);
    return { status: 'unavailable' };
  }
}
