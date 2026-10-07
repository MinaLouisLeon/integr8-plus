'use client';

import { brandAccentVariables, type Theme } from '@integr8/tokens';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { apiClient } from '~/lib/session';

/**
 * Each company's app wears that company's brand.
 *
 * The same idea as the desktop app's: the name, logo and accent colour on the
 * signed-in pages are the company's, read from `/v1/me`. The accent is applied
 * by rewriting the four accent tokens on `<html>`, so every utility built on
 * them follows; the mark goes wherever a header wants it. The public pages
 * outside the guard keep the product's own look — a visitor has no company.
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

function useResolvedTheme(): Theme {
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

/** Rewrites the accent tokens for the signed-in company; lifts them when it unmounts. */
export function BrandAccent() {
  const company = useCompany();
  const theme = useResolvedTheme();
  const colour = company.data?.brandColour ?? null;

  useEffect(() => {
    const root = document.documentElement;
    const variables = colour === null ? {} : brandAccentVariables(colour, theme);
    for (const [name, value] of Object.entries(variables)) {
      root.style.setProperty(name, value);
    }
    return () => {
      for (const name of Object.keys(variables)) {
        root.style.removeProperty(name);
      }
    };
  }, [colour, theme]);

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

/** The company's logo, if it has one, and its name. */
export function CompanyMark({ company }: { company: CompanyBrand }) {
  const logo = useLogoUrl(company.logoMediaId);

  return (
    <div className="flex items-center gap-3">
      {logo.data == null ? null : (
        <img src={logo.data} alt="" className="h-9 w-auto max-w-32 object-contain" />
      )}
      <span className="text-lg font-semibold text-content">{company.name}</span>
    </div>
  );
}
