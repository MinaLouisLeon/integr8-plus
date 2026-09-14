'use client';

import { useTranslation } from '@integr8/i18n';
import { type ScreensConfig, ScreensContext } from '@integr8/form-renderer-dom/screens';
import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { apiClient } from '~/lib/session';

/**
 * The submission screens, hosted by the web app.
 *
 * The screens are shared with the desktop app (`@integr8/form-renderer-dom`);
 * what is the web app's own is how it reaches the API — through the in-memory
 * access token and the httpOnly refresh cookie — and how it routes.
 */
export function FormScreens({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { i18n } = useTranslation();

  const config = useMemo<ScreensConfig>(
    () => ({
      client: apiClient(),
      locale: i18n.language,
      navigate: (to) => router.push(to),
      paths: {
        fill: '/fill',
        submissions: '/submissions',
        submission: (id) => `/submissions/${id}`,
      },
      download: saveFile,
    }),
    [router, i18n.language],
  );

  return <ScreensContext.Provider value={config}>{children}</ScreensContext.Provider>;
}

function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
