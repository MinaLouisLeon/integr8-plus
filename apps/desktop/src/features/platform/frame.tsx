import { type PlatformNavPath, PLATFORM_NAV_SECTIONS } from '@integr8/core';
import { LOCALE_DESCRIPTORS, type Locale, useTranslation } from '@integr8/i18n';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ChromeIconGlyph, NavIconGlyph } from '~/components/nav-icon';
import { RefreshButton } from '~/components/refresh-button';
import { UpdateBanner } from '~/components/update-banner';
import { integr8Look } from '~/lib/look';
import { staffSignOut, staffUser } from './session';

/**
 * The staff dashboard's frame in the staff desktop app (P42): Integr8's own
 * sections in a side menu, in the Integr8 Media look, and the screen beside it.
 *
 * Kept apart from the company workspace's frame, as the web dashboard was
 * kept apart from the web workspace: this is Integr8's screen, not a
 * company's, so no company's name, colours or menu are anywhere on it.
 */

/** Where each section lives under the hash router. */
export const PLATFORM_ROUTES: Readonly<Record<PlatformNavPath, string>> = {
  companies: '/platform',
  storage: '/platform/storage',
  plans: '/platform/plans',
  audit: '/platform/audit',
  flags: '/platform/flags',
  announcements: '/platform/announcements',
  templates: '/platform/templates',
  releases: '/platform/releases',
  health: '/platform/health',
  staff: '/platform/staff',
  downloads: '/platform/downloads',
};

/** The section a route belongs to: the longest matching path, so a company page is Companies. */
export function platformSectionFor(pathname: string): PlatformNavPath | undefined {
  const clean = pathname.replace(/\/+$/u, '') || '/';
  if (clean === '/platform' || clean.startsWith('/platform/companies/')) {
    return 'companies';
  }
  return (Object.entries(PLATFORM_ROUTES) as [PlatformNavPath, string][]).find(
    ([key, root]) => key !== 'companies' && (clean === root || clean.startsWith(`${root}/`)),
  )?.[0];
}

export function PlatformFrame({
  children,
  locale,
  onLocaleChange,
}: {
  children: ReactNode;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const active = platformSectionFor(location.pathname);
  const user = staffUser();

  const signOut = () => {
    void (async () => {
      await staffSignOut();
      queries.clear();
      void navigate('/sign-in', { replace: true });
    })();
  };

  return (
    <div {...integr8Look('staff')} className="flex h-dvh bg-background">
      <aside
        aria-label={t('platform.title')}
        className="flex w-64 shrink-0 flex-col border-e border-shell-border bg-shell text-shell-text print:hidden"
      >
        <div className="flex flex-col gap-0.5 border-b border-shell-border px-4 py-3 text-start">
          <span className="truncate text-sm font-extrabold" dir="ltr">
            {t('common.appName')}
          </span>
          <span className="truncate text-xs text-shell-text-muted">{t('platform.title')}</span>
        </div>

        <nav aria-label={t('platform.title')} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          <ul className="flex flex-col gap-0.5">
            {PLATFORM_NAV_SECTIONS.map((section) => {
              const current = section.key === active;
              return (
                <li key={section.key}>
                  <Link
                    to={PLATFORM_ROUTES[section.key]}
                    aria-current={current ? 'page' : undefined}
                    className={[
                      'flex items-center gap-3 rounded-md px-2 py-2 text-sm',
                      current
                        ? 'bg-shell-active font-medium text-shell-text'
                        : 'text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
                    ].join(' ')}
                  >
                    <NavIconGlyph name={section.icon} className="shrink-0" />
                    <span className="min-w-0 truncate">{t(`platform.nav.${section.key}`)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="flex flex-col gap-1 border-t border-shell-border px-2 py-3">
          {user === null ? null : (
            <p className="truncate px-2 pb-1 text-xs text-shell-text-muted">
              {t('workspace.signedInAs', { name: user.displayName })}
            </p>
          )}
          <label className="flex items-center gap-2 px-2 py-1 text-sm text-shell-text-muted">
            <span className="sr-only">{t('common.language')}</span>
            <select
              value={locale}
              onChange={(event) => onLocaleChange(event.target.value as Locale)}
              className="min-w-0 flex-1 rounded-md border border-shell-border bg-shell px-2 py-1 text-shell-text"
            >
              {LOCALE_DESCRIPTORS.map((descriptor) => (
                <option key={descriptor.code} value={descriptor.code}>
                  {descriptor.nativeName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={signOut}
            className="flex items-center gap-3 rounded-md px-2 py-2 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text"
          >
            <ChromeIconGlyph name="sign-out" className="shrink-0 rtl:-scale-x-100" />
            <span>{t('platform.nav.signOut')}</span>
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-end gap-2 border-b border-border-subtle px-6 py-2 print:hidden">
          <RefreshButton />
        </div>
        <UpdateBanner />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
