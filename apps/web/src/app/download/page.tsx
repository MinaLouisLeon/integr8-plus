import { ar, en } from '@integr8/i18n/core';
import type { Metadata } from 'next';
import { DownloadView, type ReleaseLookup } from '~/components/download-view';
import { desktopUpdateFeed, isAppName, type DesktopUpdateFeed } from '~/lib/desktop-updates';
import { readPreferences } from '~/lib/preferences';

/**
 * The download page (Low 6): the staff desktop app, a company's desktop app
 * and its phone app, in the Integr8 Media look.
 *
 * `/download?company=<slug>` is the address the API's update link and the
 * apps' Update buttons open, with the company filled in: it lists that
 * company's newest release (`company-<slug>-vX.Y.Z`), found the same way the
 * desktop updater's feed finds it (`~/lib/desktop-updates`, one cached list
 * of GitHub releases). The files are linked as the updater's are: straight to
 * GitHub, or through `/desktop-updates/<app>/download/…` for a private
 * repository. A name nobody has, or a company with nothing published yet, is
 * a sentence asking the reader to check with their administrator, never an
 * error page.
 *
 * Rendered on the server because the release list is the server's (its
 * repository and token are server settings); the words are the client's.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await readPreferences();
  const messages = locale === 'ar' ? ar : en;
  return {
    title: `${messages.site.nav.download} · ${messages.common.appName}`,
    description: messages.site.download.subtitle,
  };
}

export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { company } = await searchParams;
  const requested = (typeof company === 'string' ? company : '').trim().toLowerCase();
  const feed = desktopUpdateFeed();

  // `staff` is the staff app's name in the feed, not a company: it is listed
  // on its own below whatever is asked for.
  const slug = requested === '' || requested === 'staff' ? null : requested;
  const [staff, companyRelease] = await Promise.all([
    lookup(feed, 'staff'),
    slug === null
      ? Promise.resolve(undefined)
      : isAppName(slug)
        ? lookup(feed, slug)
        : Promise.resolve<ReleaseLookup>({ status: 'none' }),
  ]);

  return (
    <DownloadView
      staff={staff}
      company={
        slug === null || companyRelease === undefined
          ? null
          : { slug, valid: isAppName(slug), release: companyRelease }
      }
    />
  );
}

/** One app's newest installable release; never throws, the page shows what it can. */
async function lookup(feed: DesktopUpdateFeed | undefined, app: string): Promise<ReleaseLookup> {
  if (feed === undefined) {
    // No repository configured: nothing has been published from here.
    return { status: 'none' };
  }
  try {
    const release = await feed.installers(app);
    return release === undefined ? { status: 'none' } : { status: 'found', release };
  } catch (error) {
    console.error('download page', app, error);
    return { status: 'unavailable' };
  }
}
