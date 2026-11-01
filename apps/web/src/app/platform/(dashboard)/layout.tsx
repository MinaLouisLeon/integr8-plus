import type { ReactNode } from 'react';
import { PlatformShell } from '~/components/platform-shell';
import { readPreferences } from '~/lib/preferences';

/**
 * The dashboard's shell (P15).
 *
 * A route group rather than a path segment, so `/platform/sign-in` — the one
 * page a signed-out super admin must be able to reach — sits outside it and is
 * not guarded by the thing you need to be signed in to get past.
 *
 * A server component, so the menu's remembered state reaches the shell before
 * the first paint.
 *
 * The dashboard is Integr8's own screen, so it wears the Integr8 Media look
 * (Low 3): the attribute switches every token inside it, so the pages need no
 * changes of their own.
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const { sidebar } = await readPreferences();

  return (
    <div data-look="integr8" className="min-h-dvh">
      <PlatformShell initialCollapsed={sidebar === 'collapsed'}>{children}</PlatformShell>
    </div>
  );
}
