import type { NavPath } from '@integr8/core';
import { LOCALE_DESCRIPTORS, useTranslation, type Locale } from '@integr8/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { CompanyMark } from '~/components/company-brand';
import { useContextMenu } from '~/components/context-menu';
import { ImpersonationBanner } from '~/components/impersonation-banner';
import { ChromeIconGlyph, NavIconGlyph } from '~/components/nav-icon';
import { useShellChromeOverride } from '~/components/shell-chrome';
import { type Me, useMe } from '~/features/forms/api';
import { desktopNavigation, routeChrome, type DesktopNavGroup } from '~/lib/navigation';
import { readStorage, writeStorage } from '~/lib/preferences';
import { session } from '~/lib/session';

/**
 * The dashboard frame: a side menu, a top bar, and the screen.
 *
 * The menu lists the sections the shared model (`@integr8/core`) says this
 * seat may see, grouped as it groups them, in the company's shell colour. On a
 * wide window it stands at the start side and folds to its icons on request;
 * the choice is remembered. On a narrow one it is a drawer the top bar opens,
 * closed by its backdrop, by Escape or by going anywhere.
 *
 * Only logical properties here — `start`, `end`, `ms`, `pe` — so the whole
 * frame mirrors in Arabic without a second set of classes.
 */

const SIDEBAR_KEY = 'integr8.sidebar';
const DRAWER_ID = 'app-sidebar';

export function AppFrame({
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
  const me = useMe();
  const [collapsed, setCollapsed] = useState(() => readStorage(SIDEBAR_KEY) === 'collapsed');
  // The drawer is open for the route it was opened on: going anywhere closes
  // it, because the destination is what was wanted, and no effect is needed
  // to notice the move.
  const [drawerRoute, setDrawerRoute] = useState<string | null>(null);
  const drawerOpen = drawerRoute === location.pathname;
  const menuButton = useRef<HTMLButtonElement>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      writeStorage(SIDEBAR_KEY, current ? 'expanded' : 'collapsed');
      return !current;
    });
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerRoute(null);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerRoute(null);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [drawerOpen]);

  const groups = me.data === undefined ? [] : desktopNavigation(me.data.permissions);
  const chrome = routeChrome(location.pathname);

  return (
    <div className="flex h-dvh bg-background">
      {drawerOpen ? (
        <button
          type="button"
          aria-label={t('nav.closeMenu')}
          onClick={closeDrawer}
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
        />
      ) : null}

      <Sidebar
        id={DRAWER_ID}
        me={me.data}
        groups={groups}
        activeSection={chrome.section}
        collapsed={collapsed}
        drawerOpen={drawerOpen}
        onToggleCollapsed={toggleCollapsed}
        onCloseDrawer={() => {
          closeDrawer();
          menuButton.current?.focus();
        }}
        locale={locale}
        onLocaleChange={onLocaleChange}
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar
          me={me.data}
          chrome={chrome}
          drawerOpen={drawerOpen}
          menuButton={menuButton}
          onOpenDrawer={() => setDrawerRoute(location.pathname)}
        />
        <ImpersonationBanner />
        {/* The builder fills the window, so the page itself never scrolls; each screen scrolls its own content. */}
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The side menu
// ---------------------------------------------------------------------------

function Sidebar({
  id,
  me,
  groups,
  activeSection,
  collapsed,
  drawerOpen,
  onToggleCollapsed,
  onCloseDrawer,
  locale,
  onLocaleChange,
}: {
  id: string;
  me: Me | undefined;
  groups: DesktopNavGroup[];
  activeSection: NavPath | undefined;
  collapsed: boolean;
  drawerOpen: boolean;
  onToggleCollapsed: () => void;
  onCloseDrawer: () => void;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queries = useQueryClient();
  const menu = useContextMenu();
  const closeButton = useRef<HTMLButtonElement>(null);
  // The drawer always shows labels: folding to icons is for a wide window.
  const expanded = !collapsed || drawerOpen;

  useEffect(() => {
    if (drawerOpen) {
      closeButton.current?.focus();
    }
  }, [drawerOpen]);

  const signOut = () => {
    void (async () => {
      await session().signOut();
      // The next person to sign in may be somebody else, in another company;
      // nothing of this one's may be on screen for them, even for a frame.
      queries.clear();
      void navigate('/sign-in', { replace: true });
    })();
  };

  return (
    <aside
      id={id}
      aria-label={t('nav.menu')}
      className={[
        drawerOpen ? 'flex' : 'hidden',
        'fixed inset-y-0 start-0 z-40 h-dvh w-72 flex-col border-e border-shell-border bg-shell text-shell-text',
        'md:static md:flex md:h-auto',
        collapsed ? 'md:w-16' : 'md:w-64',
      ].join(' ')}
    >
      <div
        className={`flex items-center gap-2 border-b border-shell-border px-3 py-3 ${
          expanded ? '' : 'md:justify-center'
        }`}
      >
        {me === undefined ? null : (
          <div className="min-w-0 flex-1 text-start">
            <CompanyMark company={me.company} compact={!expanded} onShell />
            {expanded && me.impersonatedBy !== undefined ? (
              <p className="mt-1 truncate text-xs text-shell-text-muted">
                {t('nav.actingAs', { company: me.company.name })}
              </p>
            ) : null}
          </div>
        )}
        <button
          ref={closeButton}
          type="button"
          aria-label={t('nav.closeMenu')}
          onClick={onCloseDrawer}
          className="rounded-md p-2 text-shell-text-muted hover:bg-shell-hover hover:text-shell-text md:hidden"
        >
          <ChromeIconGlyph name="close" />
        </button>
      </div>

      <nav aria-label={t('nav.menu')} className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {groups.map(({ group, sections }) => {
          const headingId = `${id}-${group}`;
          return (
            <div key={group} role="group" aria-labelledby={headingId} className="mb-3">
              <p
                id={headingId}
                className={`px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-shell-text-muted ${
                  expanded ? '' : 'sr-only'
                }`}
              >
                {t(`nav.group.${group}`)}
              </p>
              <ul className="flex flex-col gap-0.5">
                {sections.map((section) => {
                  const active = section.path === activeSection;
                  const label = t(`nav.section.${section.path}`);
                  return (
                    <li key={section.key}>
                      <Link
                        to={section.to}
                        onContextMenu={(event) =>
                          menu.open(
                            event,
                            [
                              {
                                key: 'open',
                                label: t('operations.rowActions.open'),
                                onSelect: () => void navigate(section.to),
                              },
                              {
                                key: 'collapse',
                                label: collapsed ? t('nav.expand') : t('nav.collapse'),
                                onSelect: onToggleCollapsed,
                              },
                            ],
                            label,
                          )
                        }
                        aria-current={active ? 'page' : undefined}
                        title={expanded ? undefined : label}
                        className={[
                          'flex items-center gap-3 rounded-md px-2 py-2 text-sm',
                          expanded ? '' : 'md:justify-center',
                          active
                            ? 'bg-shell-active font-medium text-shell-text'
                            : 'text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
                        ].join(' ')}
                      >
                        <NavIconGlyph name={section.icon} className="shrink-0" />
                        <span className={`min-w-0 truncate ${expanded ? '' : 'md:sr-only'}`}>
                          {label}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="flex flex-col gap-2 border-t border-shell-border px-2 py-3">
        {expanded ? (
          <label className="flex items-center gap-2 px-2 text-sm">
            <ChromeIconGlyph name="globe" className="shrink-0 text-shell-text-muted" />
            <span className="sr-only">{t('common.language')}</span>
            <select
              value={locale}
              onChange={(event) => {
                onLocaleChange(event.target.value as Locale);
              }}
              className="min-w-0 flex-1 rounded-md border border-shell-border bg-shell px-2 py-1 text-shell-text"
            >
              {LOCALE_DESCRIPTORS.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.nativeName}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className={`flex items-center gap-1 ${expanded ? '' : 'md:flex-col'}`}>
          <button
            type="button"
            onClick={signOut}
            title={expanded ? undefined : t('common.signOut')}
            className={`flex flex-1 items-center gap-3 rounded-md px-2 py-2 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text ${
              expanded ? '' : 'md:justify-center'
            }`}
          >
            <ChromeIconGlyph name="sign-out" className="shrink-0" />
            <span className={expanded ? '' : 'md:sr-only'}>{t('common.signOut')}</span>
          </button>
          <button
            type="button"
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
            className="hidden rounded-md p-2 text-shell-text-muted hover:bg-shell-hover hover:text-shell-text md:inline-flex"
          >
            <ChromeIconGlyph
              name={collapsed ? 'chevron-end' : 'chevron-start'}
              className="rtl:-scale-x-100"
            />
          </button>
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The top bar
// ---------------------------------------------------------------------------

function TopBar({
  me,
  chrome,
  drawerOpen,
  menuButton,
  onOpenDrawer,
}: {
  me: Me | undefined;
  chrome: ReturnType<typeof routeChrome>;
  drawerOpen: boolean;
  menuButton: RefObject<HTMLButtonElement | null>;
  onOpenDrawer: () => void;
}) {
  const { t } = useTranslation();
  const override = useShellChromeOverride();

  const sectionTitle =
    chrome.section === undefined ? undefined : t(`nav.section.${chrome.section}`);
  const title = override?.title ?? sectionTitle ?? t('common.appName');
  const back =
    override?.backTo !== undefined
      ? override.backTo
      : chrome.back === undefined
        ? null
        : {
            to: chrome.back.to,
            label: t('nav.backTo', { title: t(`nav.section.${chrome.back.section}`) }),
          };

  useEffect(() => {
    const company = me?.company.name;
    document.title = company === undefined ? title : `${title} · ${company}`;
  }, [title, me?.company.name]);

  return (
    <header className="flex min-h-14 items-center gap-3 border-b border-shell-border bg-shell px-4 py-2 text-shell-text">
      <button
        ref={menuButton}
        type="button"
        aria-label={drawerOpen ? t('nav.closeMenu') : t('nav.openMenu')}
        aria-expanded={drawerOpen}
        aria-controls={DRAWER_ID}
        onClick={onOpenDrawer}
        className="rounded-md p-2 text-shell-text-muted hover:bg-shell-hover hover:text-shell-text md:hidden"
      >
        <ChromeIconGlyph name="menu" />
      </button>

      {back === null ? null : (
        <Link
          to={back.to}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-shell-text-muted hover:bg-shell-hover hover:text-shell-text"
        >
          <ChromeIconGlyph name="arrow-start" className="rtl:-scale-x-100" />
          <span className="hidden sm:inline">{back.label}</span>
          <span className="sr-only sm:hidden">{back.label}</span>
        </Link>
      )}

      <p className="min-w-0 flex-1 truncate text-start text-base font-semibold">{title}</p>

      {me === undefined ? null : (
        <p className="hidden truncate text-sm text-shell-text-muted md:block">
          {t('workspace.signedInAs', { name: me.displayName })}
        </p>
      )}
    </header>
  );
}
