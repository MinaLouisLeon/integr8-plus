import type { ReactNode } from 'react';
import { AuthShell } from '~/components/marketing-shell';

/**
 * Accepting an invitation wears the Integr8 Media look (Low 3), like the
 * sign-in it leads to. A layout, so the page keeps its own markup.
 */
export default function AcceptInvitationLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
