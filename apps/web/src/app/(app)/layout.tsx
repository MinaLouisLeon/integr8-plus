import type { ReactNode } from 'react';
import { AuthGuard } from '~/components/auth-guard';
import { WorkspaceShell } from '~/components/workspace-shell';
import { readPreferences } from '~/lib/preferences';

/**
 * The guarded shell.
 *
 * A route group, so the guard runs for everything signed-in and for nothing
 * public — a visitor reading the home page never pays for it.
 *
 * This layout is a server component. It reads the menu's remembered state and
 * hands it to the shell as a prop, so the first paint is already the right
 * width rather than snapping shut after hydration. Locale and theme are read
 * by the root layout; the theme is the company's and is applied by the shell
 * once `/v1/me` says what it is.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { sidebar } = await readPreferences();

  return (
    <AuthGuard>
      <WorkspaceShell initialCollapsed={sidebar === 'collapsed'}>{children}</WorkspaceShell>
    </AuthGuard>
  );
}
