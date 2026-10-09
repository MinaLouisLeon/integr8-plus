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
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const { sidebar } = await readPreferences();

  return <PlatformShell initialCollapsed={sidebar === 'collapsed'}>{children}</PlatformShell>;
}
