import type { ReactNode } from 'react';
import { AuthGuard } from '~/components/auth-guard';
import { PreferenceBar } from '~/components/preference-bar';
import { readPreferences } from '~/lib/preferences';

/**
 * The guarded shell.
 *
 * A route group, so the guard runs for everything signed-in and for nothing
 * public — a visitor reading the home page never pays for it.
 *
 * This layout is a server component. It reads the locale, theme and
 * right-to-left preference and hands them to the controls as props, so nothing
 * has to re-read them from `document.cookie` after hydration and then correct
 * itself on screen.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { locale, theme, forceRtl } = await readPreferences();

  return (
    <div className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-6 py-8">
      <PreferenceBar locale={locale} theme={theme} forceRtl={forceRtl} />
      <AuthGuard>{children}</AuthGuard>
    </div>
  );
}
