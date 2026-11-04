'use client';

import { isSectionHidden, sectionForPath, visibleNavigation } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { AnnouncementBanners } from '@integr8/operations-dom';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { BrandAccent, BrandTheme, CompanyMark } from '~/components/company-brand';
import { DashboardShell, type ShellNavGroup } from '~/components/dashboard-shell';
import { ImpersonationBanner } from '~/components/impersonation-banner';
import { LocaleSelect } from '~/components/locale-select';
import { KeyIcon, SignOutIcon } from '~/components/nav-icon';
import { NAV_ALIASES, NAV_PATHS, navPathForPathname } from '~/lib/navigation';
import { apiClient, signOut } from '~/lib/session';

/**
 * The signed-in company's dashboard shell.
 *
 * The menu is `@integr8/core`'s navigation model drawn for this seat: the
 * sections the permissions reveal, in the shared order, under the shared
 * headings, so the web and desktop menus cannot drift. The words are `nav.*`;
 * the routes are this app's. Until `/v1/me` answers the menu shows the one
 * section everybody has, and fills in as the answer lands.
 */
export function WorkspaceShell({
  initialCollapsed,
  children,
}: {
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
  });

  // The assistant's item is the server's answer to "may this seat see it in
  // this app", and hidden until that answer lands (docs/ai; ADR-0001).
  const capabilities = useQuery({
    queryKey: ['ai', 'capabilities'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/ai/capabilities');
      return data;
    },
    staleTime: 30_000,
  });

  const groups: ShellNavGroup[] = visibleNavigation(
    'web',
    me.data?.permissions ?? [],
    me.data?.features,
    {
      assistant: capabilities.data !== undefined && capabilities.data.level !== 'off',
      hidden: me.data?.company.hiddenSections,
    },
  ).map((group) => ({
    key: group.group,
    label: t(`nav.group.${group.group}`),
    items: group.sections.flatMap((section) => {
      // Forms, branding, the e-invoicing switch and the schedule are
      // desktop-only and filtered out above; the check keeps the type honest
      // about which paths this app has.
      if (
        section.path === 'forms' ||
        section.path === 'branding' ||
        section.path === 'eInvoicingSwitch' ||
        section.path === 'schedule'
      ) {
        return [];
      }
      const aliases = NAV_ALIASES[section.path];
      return [
        {
          key: section.key,
          href: NAV_PATHS[section.path],
          ...(aliases === undefined ? {} : { aliases }),
          label: t(`nav.section.${section.path}`),
          icon: section.icon,
        },
      ];
    }),
  }));

  const company = me.data?.company;
  // A tab Integr8 switched off for the company takes its pages with it (0075):
  // a bookmark or an old link lands on "not available", not on the screen.
  const navPath = navPathForPathname(pathname);
  const section = navPath === undefined ? undefined : sectionForPath(navPath);
  const hiddenHere = section !== undefined && isSectionHidden(section.key, company?.hiddenSections);

  return (
    <>
      {/* The company's colours and theme, on every signed-in page and none of the public ones. */}
      <BrandAccent />
      <BrandTheme />
      <DashboardShell
        navLabel={t('nav.menu')}
        groups={groups}
        initialCollapsed={initialCollapsed}
        fallbackTitle={company?.name ?? t('common.appName')}
        brand={(collapsed) =>
          company === undefined ? (
            <span className="truncate text-lg font-semibold text-shell-text">
              {collapsed ? '' : t('common.appName')}
            </span>
          ) : (
            <CompanyMark company={company} compact={collapsed} onShell />
          )
        }
        footer={(collapsed) => (
          <>
            <LocaleSelect compact={collapsed} />
            {/* Not while impersonating: the API refuses, and it is not staff's password. */}
            {me.data?.impersonatedBy !== undefined ? null : (
              <Link
                href="/account/password"
                title={collapsed ? t('auth.changePassword.menu') : undefined}
                className={[
                  'flex items-center gap-3 rounded-md py-2 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
                  collapsed ? 'justify-center px-0' : 'px-3',
                ].join(' ')}
              >
                <KeyIcon className="size-5 shrink-0" />
                {collapsed ? (
                  <span className="sr-only">{t('auth.changePassword.menu')}</span>
                ) : (
                  t('auth.changePassword.menu')
                )}
              </Link>
            )}
            <button
              type="button"
              title={collapsed ? t('common.signOut') : undefined}
              onClick={() => {
                void (async () => {
                  await signOut();
                  router.replace('/sign-in');
                })();
              }}
              className={[
                'flex items-center gap-3 rounded-md py-2 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
                collapsed ? 'justify-center px-0' : 'px-3',
              ].join(' ')}
            >
              <SignOutIcon className="size-5 shrink-0 rtl:rotate-180" />
              {collapsed ? (
                <span className="sr-only">{t('common.signOut')}</span>
              ) : (
                t('common.signOut')
              )}
            </button>
          </>
        )}
        // Above everything, on every signed-in page: a support engineer who
        // forgets they are impersonating causes the worst incidents. Integr8's
        // announcements and payment reminders follow, from the same `/v1/me`.
        banner={
          <>
            <ImpersonationBanner />
            <AnnouncementBanners announcements={me.data?.announcements} />
          </>
        }
      >
        {hiddenHere ? <SectionUnavailable /> : children}
      </DashboardShell>
    </>
  );
}

/** In place of a page whose tab Integr8 switched off for the company (0075). */
function SectionUnavailable() {
  const { t } = useTranslation();
  return (
    <div role="status" className="mx-auto flex max-w-md flex-col gap-3 px-6 py-16 text-center">
      <h1 className="text-xl font-semibold text-content">{t('nav.unavailable.title')}</h1>
      <p className="text-sm text-content-muted">{t('nav.unavailable.body')}</p>
      <Link
        href="/dashboard"
        className="text-sm font-medium text-accent underline-offset-4 hover:underline"
      >
        {t('nav.unavailable.back')}
      </Link>
    </div>
  );
}
