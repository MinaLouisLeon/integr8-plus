'use client';

import type { NavIcon } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowBack,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  MenuIcon,
  NavIconGlyph,
} from '~/components/nav-icon';
import { ShellChromeProvider, useShellChromeOverride } from '~/components/shell-chrome';
import { rememberCookie, SIDEBAR_COOKIE } from '~/lib/cookies';
import {
  isCurrentRoute,
  normalisePathname,
  routeForPathname,
  type ShellRoute,
} from '~/lib/navigation';

/**
 * The dashboard: a side menu, a slim top bar, and the page.
 *
 * One component for the customer app and the platform dashboard, because the
 * two must behave identically and differ only in what the menu lists. The
 * menu sits at the start of the line — so it is on the right in Arabic — and
 * nothing in here names left or right.
 *
 * Three states, and who owns them:
 *
 * - **Collapsed to icons**, on `md` and up. Remembered in a cookie the server
 *   layout reads, so the first paint is already the right width; a menu that
 *   renders wide and then snaps shut is a page that jumps.
 * - **The drawer**, below `md`. Opened from the top bar, closed by the backdrop,
 *   by Escape, or by going anywhere. Never remembered: a drawer that is open
 *   when a page loads is a drawer covering the page.
 * - **The top bar's words**, derived from the pathname and the menu, and
 *   overridable by the page through `useShellChrome`.
 */

export interface ShellNavItem extends ShellRoute {
  label: string;
  icon: NavIcon;
}

export interface ShellNavGroup {
  key: string;
  /** Absent for a single-group menu, which needs no heading. */
  label?: string | undefined;
  items: ShellNavItem[];
}

export interface DashboardShellProps {
  /** Names the menu for assistive technology. */
  navLabel: string;
  groups: ShellNavGroup[];
  /** The top of the menu: the company's mark, or the product's. */
  brand: (collapsed: boolean) => ReactNode;
  /** The bottom of the menu: language and sign out. */
  footer: (collapsed: boolean) => ReactNode;
  /** From the cookie, read by the server layout. */
  initialCollapsed: boolean;
  /** The title when no menu item owns the current page. */
  fallbackTitle: string;
  /** Sits above the page, inside the shell: the impersonation banner. */
  banner?: ReactNode;
  children: ReactNode;
}

export function DashboardShell({
  navLabel,
  groups,
  brand,
  footer,
  initialCollapsed,
  fallbackTitle,
  banner,
  children,
}: DashboardShellProps) {
  const { t } = useTranslation();
  const pathname = normalisePathname(usePathname());
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  // The drawer is open *on a pathname*: going anywhere else closes it, since
  // the page the person asked for is behind it — no effect needed.
  const [drawerOpenOn, setDrawerOpenOn] = useState<string | null>(null);
  const drawerOpen = drawerOpenOn === pathname;
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      rememberCookie(SIDEBAR_COOKIE, next ? 'collapsed' : 'expanded');
      return next;
    });
  };

  const closeDrawer = useCallback(() => {
    setDrawerOpenOn(null);
  }, []);

  useEffect(() => {
    if (!drawerOpen) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDrawer();
      }
    };
    document.addEventListener('keydown', onKey);
    const opener = openButton.current;
    // Focus goes into the drawer when it opens and back to the button that
    // opened it when it closes, so a keyboard is never left on something hidden.
    closeButton.current?.focus();
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [drawerOpen, closeDrawer]);

  const items = groups.flatMap((group) => group.items);

  return (
    <ShellChromeProvider>
      <div className="flex min-h-dvh">
        {/* The menu, on md and up. Sticky so it stays put while a long page scrolls. */}
        <aside
          className={[
            'sticky top-0 hidden h-dvh shrink-0 flex-col border-e border-shell-border bg-shell text-shell-text md:flex',
            'transition-[width] duration-200 motion-reduce:transition-none',
            collapsed ? 'w-16' : 'w-64',
          ].join(' ')}
        >
          <Sidebar
            navLabel={navLabel}
            groups={groups}
            pathname={pathname}
            collapsed={collapsed}
            brand={brand}
            footer={footer}
          />
        </aside>

        {/* The drawer, below md. Rendered only while open: nothing hidden to tab onto. */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <button
              type="button"
              aria-label={t('nav.closeMenu')}
              onClick={closeDrawer}
              className="absolute inset-0 bg-black/50"
            />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label={t('nav.menu')}
              className="relative flex h-dvh w-72 max-w-[85vw] flex-col border-e border-shell-border bg-shell text-shell-text shadow-xl"
            >
              <button
                ref={closeButton}
                type="button"
                aria-label={t('nav.closeMenu')}
                onClick={closeDrawer}
                className="absolute end-2 top-2 rounded-md p-2 text-shell-text-muted hover:bg-shell-hover hover:text-shell-text"
              >
                <CloseIcon />
              </button>
              <Sidebar
                navLabel={navLabel}
                groups={groups}
                pathname={pathname}
                collapsed={false}
                brand={brand}
                footer={footer}
              />
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            items={items}
            pathname={pathname}
            fallbackTitle={fallbackTitle}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onOpenDrawer={() => setDrawerOpenOn(pathname)}
            openButton={openButton}
          />
          <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-6">
            {banner}
            {children}
          </div>
        </div>
      </div>
    </ShellChromeProvider>
  );
}

function Sidebar({
  navLabel,
  groups,
  pathname,
  collapsed,
  brand,
  footer,
}: {
  navLabel: string;
  groups: ShellNavGroup[];
  pathname: string;
  collapsed: boolean;
  brand: (collapsed: boolean) => ReactNode;
  footer: (collapsed: boolean) => ReactNode;
}) {
  return (
    <>
      <div
        className={[
          'flex h-14 shrink-0 items-center border-b border-shell-border',
          collapsed ? 'justify-center px-2' : 'px-4',
        ].join(' ')}
      >
        {brand(collapsed)}
      </div>

      <nav aria-label={navLabel} className="flex-1 overflow-y-auto px-2 py-3">
        {groups.map((group, index) => (
          <div key={group.key} className={index === 0 ? '' : 'mt-3'}>
            {group.label === undefined ? null : collapsed ? (
              <div role="separator" className="mx-2 mb-2 border-t border-shell-border" />
            ) : (
              <div className="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-shell-text-muted">
                {group.label}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const current = isCurrentRoute(item, pathname);
                return (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                      className={[
                        'flex items-center gap-3 rounded-md py-2 text-sm',
                        collapsed ? 'justify-center px-0' : 'px-3',
                        current
                          ? 'bg-shell-active font-medium text-shell-text'
                          : 'text-shell-text-muted hover:bg-shell-hover hover:text-shell-text',
                      ].join(' ')}
                    >
                      <NavIconGlyph name={item.icon} />
                      {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div
        className={[
          'flex shrink-0 flex-col gap-2 border-t border-shell-border py-3',
          collapsed ? 'items-stretch px-2' : 'px-3',
        ].join(' ')}
      >
        {footer(collapsed)}
      </div>
    </>
  );
}

function TopBar({
  items,
  pathname,
  fallbackTitle,
  collapsed,
  onToggleCollapsed,
  onOpenDrawer,
  openButton,
}: {
  items: ShellNavItem[];
  pathname: string;
  fallbackTitle: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenDrawer: () => void;
  openButton: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const override = useShellChromeOverride();
  const resolved = routeForPathname(items, pathname);

  const sectionTitle = resolved?.route.label ?? fallbackTitle;
  const title = override?.title ?? sectionTitle;
  const backHref =
    override?.backHref !== undefined
      ? override.backHref
      : resolved?.nested === true
        ? resolved.route.href
        : null;
  const backLabel =
    override?.backLabel ??
    (resolved === null ? t('nav.back') : t('nav.backTo', { title: resolved.route.label }));

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border-subtle bg-background/95 px-3 backdrop-blur sm:px-4">
      <button
        ref={openButton}
        type="button"
        aria-label={t('nav.openMenu')}
        onClick={onOpenDrawer}
        className="rounded-md p-2 text-content-muted hover:bg-surface-muted hover:text-content md:hidden"
      >
        <MenuIcon />
      </button>
      <button
        type="button"
        aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
        onClick={onToggleCollapsed}
        className="hidden rounded-md p-2 text-content-muted hover:bg-surface-muted hover:text-content md:inline-flex"
      >
        {collapsed ? (
          <ExpandIcon className="size-5 shrink-0 rtl:rotate-180" />
        ) : (
          <CollapseIcon className="size-5 shrink-0 rtl:rotate-180" />
        )}
      </button>

      {backHref === null ? null : (
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-content-muted hover:bg-surface-muted hover:text-content"
        >
          <ArrowBack />
          <span className="hidden sm:inline">{backLabel}</span>
          <span className="sr-only sm:hidden">{backLabel}</span>
        </Link>
      )}

      {/* Not a heading: the page keeps its own `h1`, and two would be one too many. */}
      <p className="min-w-0 flex-1 truncate text-base font-semibold text-content" title={title}>
        {title}
      </p>
    </header>
  );
}
