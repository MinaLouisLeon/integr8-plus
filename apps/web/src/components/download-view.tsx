'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MarketingShell, PageIntro, pillClass } from '~/components/marketing-shell';
import { Magnetic } from '~/components/site/motion';
import type {
  AppRelease,
  FormsAiRelease,
  Installer,
  InstallerPlatform,
} from '~/lib/desktop-updates';
import { formatBytes } from '~/lib/platform-format';
import { apiClient } from '~/lib/session';

/** What the server found for one app (see `app/download/page.tsx`). */
export type ReleaseLookup =
  { status: 'found'; release: AppRelease } | { status: 'none' } | { status: 'unavailable' };

/** Integr8 Forms for AI, from the newest staff release that carries it. */
export type FormsAiLookup =
  { status: 'found'; release: FormsAiRelease } | { status: 'none' } | { status: 'unavailable' };

export interface CompanyLookup {
  slug: string;
  /** False for a name no company could have; then nothing was looked up. */
  valid: boolean;
  release: ReleaseLookup;
}

const DESKTOP: readonly InstallerPlatform[] = ['windows', 'macos', 'linux'];

/**
 * The download page's words and layout, from what the server looked up.
 *
 * The company's name is asked of the API's public brand route, the one its
 * apps are built from: it turns `acme` into "Acme Services", and a 404 there
 * with no release is what tells "no such company" from "nothing published
 * yet". If the API cannot be reached the short name stands in for the name.
 */
export function DownloadView({
  staff,
  formsAi,
  company,
}: {
  staff: ReleaseLookup;
  formsAi: FormsAiLookup;
  company: CompanyLookup | null;
}) {
  const { t } = useTranslation();

  return (
    <MarketingShell>
      <PageIntro
        eyebrow={t('site.download.eyebrow')}
        title={t('site.download.title')}
        gradient={t('site.download.titleGradient')}
        subtitle={t('site.download.subtitle')}
      />

      {company === null ? null : <CompanyPanel company={company} />}

      <form
        method="get"
        action="/download"
        className="mt-10 flex flex-col gap-3 rounded-3xl border border-site-line p-6 sm:p-8"
      >
        <label htmlFor="download-company" className="font-display text-lg font-semibold">
          {t('site.download.lookup.label')}
        </label>
        <p id="download-company-hint" className="text-sm text-site-muted">
          {t('site.download.lookup.hint')}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="download-company"
            name="company"
            dir="ltr"
            autoComplete="organization"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="download-company-hint"
            defaultValue={company?.slug ?? ''}
            className="w-full rounded-full border border-site-line bg-white/[0.03] px-6 py-3 text-start text-base text-site-fg placeholder:text-site-muted focus:border-lime sm:max-w-sm"
          />
          <button type="submit" className={pillClass('lime')}>
            {t('site.download.lookup.submit')}
          </button>
        </div>
      </form>

      <div className="mt-10 grid items-start gap-5 lg:grid-cols-3">
        <InfoCard
          title={t('site.download.general.companyDesktopTitle')}
          body={t('site.download.general.companyDesktopBody')}
          colour="var(--site-cyan)"
        />
        <InfoCard
          title={t('site.download.general.phoneTitle')}
          body={t('site.download.general.phoneBody')}
          colour="var(--site-lime)"
        />
        <InfoCard
          title={t('site.download.staff.title')}
          body={t('site.download.staff.body')}
          colour="var(--site-violet)"
        >
          {staff.status === 'found' ? (
            <>
              <p className="font-mono text-xs text-site-muted">
                {t('site.download.company.version', { version: staff.release.version })}
              </p>
              <InstallerList installers={staff.release.installers} platforms={DESKTOP} />
            </>
          ) : (
            <p className="text-sm text-site-muted">
              {staff.status === 'unavailable'
                ? t('site.download.unavailable')
                : t('site.download.staff.none')}
            </p>
          )}
          {formsAi.status === 'found' ? <FormsAiSection release={formsAi.release} /> : null}
        </InfoCard>
      </div>
    </MarketingShell>
  );
}

function CompanyPanel({ company }: { company: CompanyLookup }) {
  const { t } = useTranslation();

  const brand = useQuery({
    queryKey: ['public', 'brand', company.slug],
    enabled: company.valid,
    retry: false,
    queryFn: async () => {
      try {
        const { data } = await apiClient().GET('/v1/public/companies/{slug}/brand', {
          params: { path: { slug: company.slug } },
        });
        return data === undefined ? null : { found: true as const, name: data.name };
      } catch (failure) {
        if (failure instanceof ApiRequestError && failure.status === 404) {
          return { found: false as const };
        }
        // Unreachable, or refused for another reason: carry on with the short name.
        return null;
      }
    },
  });

  const name = brand.data?.found === true ? brand.data.name : company.slug;
  const unknown = !company.valid || brand.data?.found === false;
  const release = company.release;

  if (release.status !== 'found') {
    const message =
      release.status === 'unavailable'
        ? t('site.download.unavailable')
        : unknown
          ? t('site.download.company.notFound', { company: company.slug })
          : t('site.download.company.noRelease');
    return (
      <section
        aria-labelledby="company-apps"
        className="rounded-3xl border border-site-line bg-site-soft p-7 sm:p-10"
      >
        <h2 id="company-apps" className="font-display text-2xl font-semibold sm:text-3xl">
          {t('site.download.company.title', { company: unknown ? company.slug : name })}
        </h2>
        <p role="status" className="mt-4 max-w-2xl text-site-muted">
          {message}
        </p>
        {unknown ? null : (
          <p className="mt-3 max-w-2xl text-sm text-site-muted">
            {t('site.download.company.phoneSent')}
          </p>
        )}
      </section>
    );
  }

  const phone = release.release.installers.filter((file) => file.platform === 'android');

  return (
    <section
      aria-labelledby="company-apps"
      className="relative overflow-hidden rounded-3xl border border-site-line bg-site-soft p-7 sm:p-10"
    >
      <div
        aria-hidden="true"
        className="site-glow size-72 opacity-20"
        style={{
          background: 'var(--site-lime)',
          insetBlockStart: '-8rem',
          insetInlineEnd: '-6rem',
        }}
      />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <h2 id="company-apps" className="font-display text-2xl font-semibold sm:text-4xl">
          {t('site.download.company.title', { company: name })}
        </h2>
        <span className="rounded-full border border-site-line px-3 py-1 font-mono text-xs text-site-muted">
          {t('site.download.company.version', { version: release.release.version })}
        </span>
      </div>

      <div className="relative mt-8 grid gap-8 lg:grid-cols-[2fr_1fr]">
        <div>
          <h3 className="mb-4 font-mono text-xs tracking-[0.2em] text-site-muted uppercase rtl:tracking-normal">
            {t('site.download.company.desktop')}
          </h3>
          <InstallerList installers={release.release.installers} platforms={DESKTOP} />
        </div>
        <div>
          <h3 className="mb-4 font-mono text-xs tracking-[0.2em] text-site-muted uppercase rtl:tracking-normal">
            {t('site.download.company.phone')}
          </h3>
          {phone.length === 0 ? (
            <p className="text-sm text-site-muted">{t('site.download.company.phoneSent')}</p>
          ) : (
            <>
              <InstallerList installers={phone} platforms={['android']} />
              <p className="mt-3 text-sm text-site-muted">
                {t('site.download.company.phoneAndroid')}
              </p>
            </>
          )}
        </div>
      </div>

      <p className="relative mt-8 max-w-2xl border-t border-site-line pt-6 text-sm text-site-muted">
        {t('site.download.company.updatesNote')}
      </p>
    </section>
  );
}

/**
 * Integr8 Forms for AI inside the staff card: one program file per computer,
 * linked like the installers. Shown only when a release carries it; the
 * program itself is English only, these words are the page's.
 */
function FormsAiSection({ release }: { release: FormsAiRelease }) {
  const { t, i18n } = useTranslation();
  return (
    <section
      aria-labelledby="forms-ai"
      className="mt-2 flex flex-col gap-3 border-t border-site-line pt-5"
    >
      <h3 id="forms-ai" className="font-display text-lg font-semibold">
        {t('site.download.formsAi.title')}
      </h3>
      <p className="text-sm leading-relaxed text-site-muted">{t('site.download.formsAi.body')}</p>
      <p className="font-mono text-xs text-site-muted">
        {t('site.download.company.version', { version: release.version })}
      </p>
      <ul className="flex flex-col gap-2">
        {release.downloads.map((file) => (
          <li key={file.name}>
            <a
              href={file.url}
              download
              aria-label={t('site.download.file', { name: file.name })}
              className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-site-line bg-white/[0.02] px-4 py-3 transition-colors hover:border-lime"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-sm text-site-fg">
                  {t(`site.download.platforms.${file.platform}`)}
                </span>
                <span className="truncate font-mono text-[11px] text-site-muted">
                  {[
                    t('site.download.formsAi.program'),
                    t(`site.download.architecture.${file.arch}`),
                    file.size === null ? null : formatBytes(file.size, i18n.language),
                  ]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-lime text-site-bg transition-transform group-hover:translate-y-0.5"
              >
                ↓
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="text-xs text-site-muted">{t('site.download.formsAi.warning')}</p>
    </section>
  );
}

/** The files for the given platforms, a group per platform, each a download link. */
function InstallerList({
  installers,
  platforms,
}: {
  installers: readonly Installer[];
  platforms: readonly InstallerPlatform[];
}) {
  const { t, i18n } = useTranslation();
  const groups = platforms
    .map((platform) => ({
      platform,
      files: installers.filter((file) => file.platform === platform),
    }))
    .filter((group) => group.files.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.platform} className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-site-fg">
            {t(`site.download.platforms.${group.platform}`)}
          </p>
          <ul className="flex flex-col gap-2">
            {group.files.map((file) => (
              <li key={file.name}>
                <Magnetic strength={0.15} className="w-full">
                  <a
                    href={file.url}
                    download
                    aria-label={t('site.download.file', { name: file.name })}
                    className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-site-line bg-white/[0.02] px-4 py-3 transition-colors hover:border-lime"
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm text-site-fg">
                        {t(`site.download.kinds.${file.kind}`)}
                      </span>
                      <span className="truncate font-mono text-[11px] text-site-muted">
                        {[
                          file.arch === null ? null : t(`site.download.architecture.${file.arch}`),
                          file.size === null ? null : formatBytes(file.size, i18n.language),
                        ]
                          .filter((part) => part !== null)
                          .join(' · ')}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-lime text-site-bg transition-transform group-hover:translate-y-0.5"
                    >
                      ↓
                    </span>
                  </a>
                </Magnetic>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function InfoCard({
  title,
  body,
  colour,
  children,
}: {
  title: string;
  body: string;
  colour: string;
  children?: ReactNode;
}) {
  return (
    <section className="relative flex flex-col gap-4 overflow-hidden rounded-3xl border border-site-line bg-site-soft p-7">
      <span aria-hidden="true" className="h-0.5 w-12 rounded-full" style={{ background: colour }} />
      <h2 className="font-display text-xl font-semibold">{title}</h2>
      <p className="text-sm leading-relaxed text-site-muted">{body}</p>
      {children}
    </section>
  );
}
