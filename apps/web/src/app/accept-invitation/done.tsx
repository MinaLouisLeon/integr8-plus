'use client';

import { useTranslation } from '@integr8/i18n';
import type { paths } from '@integr8/api-client';
import { formatBytes } from '~/lib/platform-format';

type Accepted =
  paths['/v1/invitations/accept']['post']['responses'][200]['content']['application/json'];
type CompanyApps = Accepted['apps'];
type Installer = Extract<CompanyApps, { status: 'found' }>['release']['installers'][number];

const DESKTOP: readonly Installer['platform'][] = ['windows', 'macos', 'linux'];

/**
 * The page's last step (P42): the password is set (or, for an address that
 * already signed in, the person has joined), and the way on is the company's
 * own desktop or phone app. Nothing here signs in.
 *
 * The company's installers come with the API's answer to accepting, and this
 * is the only place they are listed: the public download page, which listed
 * them for any company name somebody guessed, was removed. The invitation is
 * spent by now, so the page says to download them here and ask the office for
 * them later.
 */
export function InvitationDone({
  done,
}: {
  done: {
    email: string;
    existingAccount: boolean;
    company: { name: string; slug: string } | null;
    apps: CompanyApps;
  };
}) {
  const { t } = useTranslation();
  const company = done.company?.name ?? '';
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-6 py-24">
      <div className="flex flex-col gap-1" role="status">
        <h1 className="text-2xl font-semibold text-content">
          {done.existingAccount ? t('auth.accept.doneTitleExisting') : t('auth.accept.doneTitle')}
        </h1>
        <p className="text-sm text-content-muted">
          {done.existingAccount
            ? t('auth.accept.doneExisting', { email: done.email, company })
            : t('auth.accept.doneNew', { email: done.email, company })}
        </p>
        <p className="text-sm text-content-muted">{t('auth.accept.doneApps', { company })}</p>
      </div>
      <CompanyApps apps={done.apps} company={company} />
    </main>
  );
}

function CompanyApps({ apps, company }: { apps: CompanyApps; company: string }) {
  const { t } = useTranslation();

  if (apps.status !== 'found') {
    return (
      <p className="rounded-md border border-border-subtle bg-surface px-4 py-3 text-sm text-content-muted">
        {apps.status === 'unavailable'
          ? t('auth.accept.appsUnavailable')
          : t('site.download.company.noRelease')}
      </p>
    );
  }

  const phone = apps.release.installers.filter((file) => file.platform === 'android');
  return (
    <section
      aria-labelledby="company-apps"
      className="flex flex-col gap-5 rounded-md border border-border-subtle bg-surface p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="company-apps" className="text-lg font-semibold text-content">
          {t('auth.accept.getTheApps', { company })}
        </h2>
        <span className="text-xs text-content-muted">
          {t('site.download.company.version', { version: apps.release.version })}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-content">{t('site.download.company.desktop')}</h3>
        <InstallerList installers={apps.release.installers} platforms={DESKTOP} />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-content">{t('site.download.company.phone')}</h3>
        {phone.length === 0 ? (
          <p className="text-sm text-content-muted">{t('site.download.company.phoneSent')}</p>
        ) : (
          <>
            <InstallerList installers={phone} platforms={['android']} />
            <p className="text-sm text-content-muted">{t('site.download.company.phoneAndroid')}</p>
          </>
        )}
      </div>

      <p className="border-t border-border-subtle pt-4 text-sm text-content-muted">
        {t('auth.accept.appsOnlyHere')}
      </p>
    </section>
  );
}

/** The files for the given platforms, a group per platform, each a download link. */
function InstallerList({
  installers,
  platforms,
}: {
  installers: readonly Installer[];
  platforms: readonly Installer['platform'][];
}) {
  const { t, i18n } = useTranslation();
  const groups = platforms
    .map((platform) => ({
      platform,
      files: installers.filter((file) => file.platform === platform),
    }))
    .filter((group) => group.files.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => (
        <div key={group.platform} className="flex flex-col gap-1.5">
          <p className="text-xs text-content-muted">
            {t(`site.download.platforms.${group.platform}`)}
          </p>
          <ul className="flex flex-col gap-1.5">
            {group.files.map((file) => (
              <li key={file.name}>
                <a
                  href={file.url}
                  download
                  aria-label={t('site.download.file', { name: file.name })}
                  className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm text-content hover:border-accent"
                >
                  <span className="flex min-w-0 flex-col">
                    <span>{t(`site.download.kinds.${file.kind}`)}</span>
                    <span className="truncate text-xs text-content-muted">
                      {[
                        file.arch === null ? null : t(`site.download.architecture.${file.arch}`),
                        file.size === null ? null : formatBytes(file.size, i18n.language),
                      ]
                        .filter((part) => part !== null)
                        .join(' · ')}
                    </span>
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-accent">
                    ↓
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
