import { brandAccentVariables, type Theme } from '@integr8/tokens';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { type Me, useMe } from '~/features/forms/api';
import { session } from '~/lib/session';

/**
 * Each company's app wears that company's brand.
 *
 * The product is sold to a company as *its* app, so the name, logo and accent
 * colour on screen are the company's, read from `/v1/me` on every launch. Two
 * pieces: a mark (logo and name) for headers, and an effect that rewrites the
 * accent tokens on `<html>` so every button and badge follows without a
 * rebuild. Nothing of the company's is baked into the binary: the same build
 * serves every company, and changing the colour in settings changes the app
 * the next time it opens.
 */

/** Which theme is on screen now: the explicit choice, else the system's. */
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

/**
 * Rewrites the accent tokens for the signed-in company, and puts them back
 * when there is no colour or no session.
 */
export function BrandAccent() {
  const me = useMe();
  const theme = useResolvedTheme();
  const colour = me.data?.company.brandColour ?? null;

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

/** A link to the logo, renewed before the five-minute link lapses. */
function useLogoUrl(logoMediaId: string | null) {
  return useQuery({
    queryKey: ['media', 'logo', logoMediaId],
    enabled: logoMediaId !== null,
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/media/{mediaId}', {
        params: { path: { mediaId: logoMediaId ?? '' } },
      });
      return data?.url ?? null;
    },
  });
}

/** The company's logo, if it has one, and its name. For the top of a screen. */
export function CompanyMark({ company }: { company: Me['company'] }) {
  const logo = useLogoUrl(company.logoMediaId);

  return (
    <div className="flex items-center gap-3">
      {logo.data == null ? null : (
        // Decorative beside the name, which carries the meaning.
        <img src={logo.data} alt="" className="h-9 w-auto max-w-32 object-contain" />
      )}
      <span className="text-lg font-semibold text-content">{company.name}</span>
    </div>
  );
}
