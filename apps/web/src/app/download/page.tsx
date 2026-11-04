import { ar, en } from '@integr8/i18n/core';
import type { Metadata } from 'next';
import { DownloadView } from '~/components/download-view';
import { desktopUpdateFeed, isAppName } from '~/lib/desktop-updates';
import { readPreferences } from '~/lib/preferences';
import { lookupInstallers, type ReleaseLookup } from '~/lib/release-lookup';

/**
 * The download page (Low 6): a company's desktop app and its phone app, in the
 * Integr8 Media look. Companies' apps only: the staff app and Integr8 Forms
 * for AI are on the dashboard's Downloads page, behind the staff sign-in.
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

  // `staff` is the staff app's name in the feed, not a company, and is not
  // offered here.
  const slug = requested === '' || requested === 'staff' ? null : requested;
  const release =
    slug === null
      ? undefined
      : isAppName(slug)
        ? await lookupInstallers(desktopUpdateFeed(), slug)
        : ({ status: 'none' } satisfies ReleaseLookup);

  return (
    <DownloadView
      company={
        slug === null || release === undefined ? null : { slug, valid: isAppName(slug), release }
      }
    />
  );
}
