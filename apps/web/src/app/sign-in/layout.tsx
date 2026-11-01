import type { ReactNode } from 'react';
import { AuthShell } from '~/components/marketing-shell';

/**
 * Sign-in wears the Integr8 Media look (Low 3). A layout rather than an edit
 * to the page, so the form keeps its own markup and its own history.
 */
export default function SignInLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
