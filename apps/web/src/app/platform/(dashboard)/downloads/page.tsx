'use client';

import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '~/components/ui';
import type { InstallerPlatform } from '~/lib/desktop-updates';
import { ensurePlatformToken } from '~/lib/platform-session';
import { formatBytes } from '~/lib/platform-format';
import type { FormsAiLookup, ReleaseLookup } from '~/lib/release-lookup';

/**
 * The staff apps, for Integr8's own team: the staff desktop app and Integr8
 * Forms for AI. They used to sit on the public `/download` page; they are here
 * so only signed-in staff are offered them. The list comes from this server's
 * `/api/platform/downloads`, which checks the staff session with the API first.
 */

interface Downloads {
  staff: ReleaseLookup;
  formsAi: FormsAiLookup;
}

const DESKTOP: readonly InstallerPlatform[] = ['windows', 'macos', 'linux'];

export default function DownloadsPage() {
  const { t } = useTranslation();

  const downloads = useQuery({
    queryKey: ['platform', 'downloads'],
    queryFn: async (): Promise<Downloads> => {
      const token = await ensurePlatformToken();
      const response = await fetch('/api/platform/downloads', {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`downloads: ${String(response.status)}`);
      }
      return (await response.json()) as Downloads;
    },
  });

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.downloads.title')}</h1>
        <p className="max-w-2xl text-sm text-content-muted">{t('platform.downloads.subtitle')}</p>
      </header>

      {downloads.isPending ? <LoadingState /> : null}
      {downloads.isError ? <ErrorState onRetry={() => void downloads.refetch()} /> : null}

      {downloads.isSuccess ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card
            title={t('site.download.staff.title')}
            body={t('site.download.staff.body')}
            version={
              downloads.data.staff.status === 'found' ? downloads.data.staff.release.version : null
            }
          >
            {downloads.data.staff.status === 'found' ? (
              DESKTOP.map((platform) => {
                const files =
                  downloads.data.staff.status === 'found'
                    ? downloads.data.staff.release.installers.filter(
                        (file) => file.platform === platform,
                      )
                    : [];
                return files.length === 0 ? null : (
                  <FileGroup key={platform} title={t(`site.download.platforms.${platform}`)}>
                    {files.map((file) => (
                      <FileLink
                        key={file.name}
                        url={file.url}
                        name={file.name}
                        label={t(`site.download.kinds.${file.kind}`)}
                        detail={[
                          file.arch === null ? null : t(`site.download.architecture.${file.arch}`),
                          file.size,
                        ]}
                      />
                    ))}
                  </FileGroup>
                );
              })
            ) : (
              <Missing
                text={
                  downloads.data.staff.status === 'unavailable'
                    ? t('site.download.unavailable')
                    : t('platform.downloads.staffNone')
                }
              />
            )}
          </Card>

          <Card
            title={t('site.download.formsAi.title')}
            body={t('site.download.formsAi.body')}
            version={
              downloads.data.formsAi.status === 'found'
                ? downloads.data.formsAi.release.version
                : null
            }
          >
            {downloads.data.formsAi.status === 'found' ? (
              <>
                <FileGroup title={t('site.download.formsAi.program')}>
                  {downloads.data.formsAi.release.downloads.map((file) => (
                    <FileLink
                      key={file.name}
                      url={file.url}
                      name={file.name}
                      label={t(`site.download.platforms.${file.platform}`)}
                      detail={[t(`site.download.architecture.${file.arch}`), file.size]}
                    />
                  ))}
                </FileGroup>
                <p className="text-xs text-content-muted">{t('site.download.formsAi.warning')}</p>
              </>
            ) : (
              <Missing
                text={
                  downloads.data.formsAi.status === 'unavailable'
                    ? t('site.download.unavailable')
                    : t('platform.downloads.formsAiNone')
                }
              />
            )}
          </Card>
        </div>
      ) : null}
    </main>
  );
}

function Card({
  title,
  body,
  version,
  children,
}: {
  title: string;
  body: string;
  version: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border-subtle bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-content">{title}</h2>
        {version === null ? null : (
          <span className="font-mono text-xs text-content-muted">
            {t('site.download.company.version', { version })}
          </span>
        )}
      </div>
      <p className="text-sm text-content-muted">{body}</p>
      {children}
    </section>
  );
}

function FileGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-content">{title}</h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}

function FileLink({
  url,
  name,
  label,
  detail,
}: {
  url: string;
  name: string;
  label: string;
  /** Shown after the label: words, or a size in bytes; nulls are left out. */
  detail: readonly (string | number | null)[];
}) {
  const { t, i18n } = useTranslation();
  const parts = detail
    .filter((part) => part !== null)
    .map((part) => (typeof part === 'number' ? formatBytes(part, i18n.language) : part));
  return (
    <li>
      <a
        href={url}
        download
        aria-label={t('site.download.file', { name })}
        className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-4 py-3 hover:border-accent"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm text-content">{label}</span>
          <span className="truncate font-mono text-xs text-content-muted">{parts.join(' · ')}</span>
        </span>
        <span aria-hidden="true" className="text-content-muted">
          ↓
        </span>
      </a>
    </li>
  );
}

function Missing({ text }: { text: string }) {
  return <p className="text-sm text-content-muted">{text}</p>;
}
