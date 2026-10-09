'use client';

import { brandAccentVariables, brandShellVariables, type Theme } from '@integr8/tokens';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { publicLogoUrl, rememberBrand, type ThemeChoice } from '~/lib/brand-memory';
import { rememberCookie, THEME_COOKIE } from '~/lib/cookies';
import { apiClient } from '~/lib/session';

/**
 * Each company's app wears that company's brand.
 *
 * The same idea as the desktop app's: the name, logo, colours and theme on the
 * signed-in pages are the company's, read from `/v1/me`, and set by Integr8
 * rather than chosen seat by seat. The accent is applied by rewriting the four
 * accent tokens on `<html>`, the menu by rewriting the six shell tokens, so
 * every utility built on them follows; the theme goes on `data-theme` and into
 * its cookie so the server renders it right next time. The mark goes wherever
 * a header wants it. The public pages outside the guard keep the product's own
 * look — a visitor has no company — except the sign-in page, which remembers.
 */

export interface CompanyBrand {
  name: string;
  logoMediaId: string | null;
  brandColour: string | null;
}

function useCompany() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/me');
      return data;
    },
    select: (me) => me?.company,
  });
}

/** Light or dark, as the page is actually showing: the attribute, else the system. */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', notify);
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return () => {
        media.removeEventListener('change', notify);
        observer.disconnect();
      };
    },
    () => {
      const chosen = document.documentElement.dataset.theme;
      if (chosen === 'dark' || chosen === 'light') {
        return chosen;
      }
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    },
    () => 'light',
  );
}

function useRootVariables(variables: Record<string, string>): void {
  // Keyed by content, so the effect runs when a colour changes and not when
  // the same object is rebuilt.
  const serialised = JSON.stringify(variables);
  useEffect(() => {
    const root = document.documentElement;
    const entries = Object.entries(JSON.parse(serialised) as Record<string, string>);
    for (const [name, value] of entries) {
      root.style.setProperty(name, value);
    }
    return () => {
      for (const [name] of entries) {
        root.style.removeProperty(name);
      }
    };
  }, [serialised]);
}

/** Rewrites the accent tokens for a colour; lifts them when the colour goes or the caller unmounts. */
export function useBrandAccent(colour: string | null): void {
  const theme = useResolvedTheme();
  useRootVariables(colour === null ? {} : brandAccentVariables(colour, theme));
}

/** Rewrites the shell tokens — the menu's colours — for a colour; lifts them on unmount. */
export function useBrandShell(colour: string | null): void {
  useRootVariables(colour === null ? {} : brandShellVariables(colour));
}

/**
 * Puts the company's theme on `<html>`.
 *
 * `system` removes the attribute so the stylesheet follows the operating
 * system. With `persist`, the choice is also written to the theme cookie the
 * root layout reads, so the next load is right from the first byte.
 */
export function useBrandTheme(theme: ThemeChoice | null, persist: boolean): void {
  useEffect(() => {
    if (theme === null) {
      return;
    }
    const root = document.documentElement;
    if (theme === 'system') {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = theme;
    }
    if (persist) {
      rememberCookie(THEME_COOKIE, theme);
    }
  }, [theme, persist]);
}

/** Rewrites the accent tokens for the signed-in company; lifts them when it unmounts. */
export function BrandAccent() {
  const company = useCompany();
  useBrandAccent(company.data?.brandColour ?? null);
  return null;
}

/**
 * The rest of the company's look: its theme, its menu colour, and a note of
 * all of it for the sign-in page to show next time.
 */
export function BrandTheme() {
  const company = useCompany();
  const brand = company.data;

  useBrandTheme(brand?.defaultTheme ?? null, true);
  useBrandShell(brand?.shellColour ?? null);

  const name = brand?.name;
  const slug = brand?.slug;
  const hasLogo = brand?.logoMediaId !== null && brand?.logoMediaId !== undefined;
  const brandColour = brand?.brandColour ?? null;
  const shellColour = brand?.shellColour ?? null;
  const defaultTheme = brand?.defaultTheme ?? 'system';

  useEffect(() => {
    if (name === undefined || slug === undefined) {
      return;
    }
    rememberBrand({
      name,
      logoUrl: hasLogo ? publicLogoUrl(slug) : null,
      brandColour,
      shellColour,
      defaultTheme,
    });
  }, [name, slug, hasLogo, brandColour, shellColour, defaultTheme]);

  return null;
}

function useLogoUrl(logoMediaId: string | null) {
  return useQuery({
    queryKey: ['media', 'logo', logoMediaId],
    enabled: logoMediaId !== null,
    // The link lasts five minutes; ask again a little before that.
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const { data } = await apiClient().GET('/v1/media/{mediaId}', {
        params: { path: { mediaId: logoMediaId ?? '' } },
      });
      return data?.url ?? null;
    },
  });
}

/** A company's first letter in its accent colour, for when there is no logo to show. */
export function Monogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={[
        'inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-accent text-base font-semibold text-on-accent',
        className ?? '',
      ].join(' ')}
    >
      {[...name.trim()][0]?.toUpperCase() ?? ''}
    </span>
  );
}

export interface CompanyMarkProps {
  company: CompanyBrand;
  /** Only the logo (or monogram), for a collapsed menu. */
  compact?: boolean;
  /** Drawn on the shell's colours rather than the page's. */
  onShell?: boolean;
}

/** The company's logo, if it has one, and its name. */
export function CompanyMark({ company, compact = false, onShell = false }: CompanyMarkProps) {
  const logo = useLogoUrl(company.logoMediaId);
  const mark =
    logo.data == null ? (
      <Monogram name={company.name} />
    ) : (
      <img
        src={logo.data}
        alt=""
        className={['h-9 w-auto object-contain', compact ? 'max-w-12' : 'max-w-32'].join(' ')}
      />
    );

  if (compact) {
    return (
      <span title={company.name} className="inline-flex items-center justify-center">
        {mark}
        <span className="sr-only">{company.name}</span>
      </span>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-3">
      {mark}
      <span
        className={[
          'truncate text-lg font-semibold',
          onShell ? 'text-shell-text' : 'text-content',
        ].join(' ')}
      >
        {company.name}
      </span>
    </div>
  );
}
