import type { ReactNode } from 'react';
import { PlatformShell } from '~/components/platform-shell';

/**
 * The dashboard's shell (P15).
 *
 * A route group rather than a path segment, so `/platform/sign-in` — the one
 * page a signed-out super admin must be able to reach — sits outside it and is
 * not guarded by the thing you need to be signed in to get past.
 */
export default function PlatformLayout({ children }: { children: ReactNode }) {
  return <PlatformShell>{children}</PlatformShell>;
}
