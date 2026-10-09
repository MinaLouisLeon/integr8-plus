import type { Theme } from '@integr8/tokens';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { type Me, useMe } from '~/features/forms/api';
import {
  applyBrandVariables,
  applyTheme,
  brandVariables,
  rememberBrand,
  rememberCompanyTheme,
} from '~/lib/company-theme';
import { session } from '~/lib/session';

/**
 * Each company's app wears that company's brand.
 *
 * The product is sold to a company as *its* app, so the name, logo, theme and
 * colours on screen are the company's, read from `/v1/me` on every launch. Two
 * pieces: a mark (logo and name) for the menu and the dashboard, and an effect
 * that sets the theme and rewrites the accent and shell tokens on `<html>` so
 * every button, badge and the menu itself follow without a rebuild. Nothing of
 * the company's is baked into the binary: the same build serves every company,
 * and changing a colour on the branding screen changes the app the next time
 * it opens — and, here, the moment the screen saves.
 */

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeToSystemTheme(notify: () => void): () => void {
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener('change', notify);
  return () => {
    media.removeEventListener('change', notify);
  };
}

/** The operating system's choice, live. */
export function useSystemTheme(): Theme {
  return useSyncExternalStore(
    subscribeToSystemTheme,
    () => (window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'),
    () => 'light',
  );
}

/** Which theme is on screen now: the explicit choice on `<html>`, else the system's. */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(
    (notify) => {
      const unsubscribe = subscribeToSystemTheme(notify);
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      });
      return () => {
        unsubscribe();
        observer.disconnect();
      };
    },
    () => {
      const chosen = document.documentElement.dataset.theme;
      if (chosen === 'dark' || chosen === 'light') {
        return chosen;
      }
      return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
    },
    () => 'light',
  );
}

/**
 * Applies the signed-in company's theme and colours, remembers them for the
 * next launch, and lifts the colours again when there is no session.
 */
export function CompanyBrand() {
  const me = useMe();
  const theme = useResolvedTheme();
  const company = me.data?.company;
  const brandColour = company?.brandColour ?? null;
  const shellColour = company?.shellColour ?? null;
  const defaultTheme = company?.defaultTheme;

  useEffect(() => {
    if (defaultTheme === undefined) {
      return;
    }
    applyTheme(defaultTheme);
    rememberCompanyTheme(defaultTheme);
  }, [defaultTheme]);

  useEffect(() => {
    if (company !== undefined) {
      rememberBrand(company);
    }
  }, [company]);

  useEffect(() => {
    if (company === undefined) {
      return;
    }
    return applyBrandVariables(brandVariables(brandColour, shellColour, theme));
  }, [company, brandColour, shellColour, theme]);

  return null;
}

/** Kept for callers that knew the effect by its old name. */
export const BrandAccent = CompanyBrand;

/** A link to a stored image, renewed before the five-minute link lapses. */
export function useMediaUrl(mediaId: string | null) {
  return useQuery({
    queryKey: ['media', 'url', mediaId],
    enabled: mediaId !== null,
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/media/{mediaId}', {
        params: { path: { mediaId: mediaId ?? '' } },
      });
      return data?.url ?? null;
    },
  });
}

/**
 * The company's logo, if it has one, and its name. For the top of the menu and
 * of the dashboard. `compact` shows the logo alone — or the first letter of the
 * name when there is no logo — for a menu folded to its icons.
 */
export function CompanyMark({
  company,
  compact = false,
  onShell = false,
}: {
  company: Pick<Me['company'], 'name' | 'logoMediaId'>;
  compact?: boolean;
  onShell?: boolean;
}) {
  const logo = useMediaUrl(company.logoMediaId);
  const text = onShell ? 'text-shell-text' : 'text-content';

  if (compact) {
    return logo.data == null ? (
      <span
        aria-label={company.name}
        role="img"
        className={`flex size-9 items-center justify-center rounded-md bg-accent text-base font-semibold text-on-accent`}
      >
        {company.name.trim().charAt(0).toUpperCase()}
      </span>
    ) : (
      <img src={logo.data} alt={company.name} className="size-9 object-contain" />
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-3">
      {logo.data == null ? null : (
        // Decorative beside the name, which carries the meaning.
        <img src={logo.data} alt="" className="h-9 w-auto max-w-32 object-contain" />
      )}
      <span className={`min-w-0 truncate text-lg font-semibold ${text}`}>{company.name}</span>
    </div>
  );
}
