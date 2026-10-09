'use client';

import { visibleNavigation } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { BrandAccent, BrandTheme, CompanyMark } from '~/components/company-brand';
import { DashboardShell, type ShellNavGroup } from '~/components/dashboard-shell';
import { ImpersonationBanner } from '~/components/impersonation-banner';
import { LocaleSelect } from '~/components/locale-select';
import { SignOutIcon } from '~/components/nav-icon';
import { NAV_ALIASES, NAV_PATHS } from '~/lib/navigation';
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

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
  });

  const groups: ShellNavGroup[] = visibleNavigation('web', me.data?.permissions ?? []).map(
    (group) => ({
      key: group.group,
      label: t(`nav.group.${group.group}`),
      items: group.sections.flatMap((section) => {
        // Forms and branding are desktop-only and filtered out above; the
        // check keeps the type honest about which paths this app has.
        if (section.path === 'forms' || section.path === 'branding') {
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
    }),
  );

  const company = me.data?.company;

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
        // forgets they are impersonating causes the worst incidents.
        banner={<ImpersonationBanner />}
      >
        {children}
      </DashboardShell>
    </>
  );
}
