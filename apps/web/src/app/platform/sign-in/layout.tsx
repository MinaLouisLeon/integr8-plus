import type { ReactNode } from 'react';
import { AuthShell } from '~/components/marketing-shell';

/**
 * The staff sign-in wears the Integr8 Media look (Low 3), as the dashboard
 * behind it does. A layout, so the page keeps its own markup.
 */
export default function PlatformSignInLayout({ children }: { children: ReactNode }) {
  return <AuthShell audience="staff">{children}</AuthShell>;
}
