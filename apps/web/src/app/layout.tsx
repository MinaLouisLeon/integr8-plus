import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '~/components/providers';
import { readPreferences } from '~/lib/preferences';
import './globals.css';

export const metadata: Metadata = {
  title: 'Integr8 Plus',
  description: 'Multi-tenant field operations platform.',
};

/**
 * The root layout.
 *
 * It is a server component so `lang` and `dir` are in the first byte. Deciding
 * direction in the browser instead produces a visible flash as a right-to-left
 * layout snaps into place after hydration, and on a slow connection that flash
 * lasts a second.
 *
 * `data-theme` is set the same way, from a cookie. The theme is the company's:
 * the signed-in shell writes it there once `/v1/me` says what it is, so a
 * company that wears dark does not get a white page first on the next load.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, direction, theme } = await readPreferences();

  return (
    <html
      lang={locale}
      dir={direction}
      {...(theme === 'system' ? {} : { 'data-theme': theme })}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-background text-content antialiased">
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
