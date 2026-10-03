'use client';

import { createI18n, I18nextProvider, type Locale } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * Everything the tree needs, in one place.
 *
 * Both providers are created inside `useState` rather than at module scope. On
 * the server that matters: a module-level instance is shared between concurrent
 * requests, so one person's locale — or worse, one person's cached query data —
 * would leak into another's response.
 */

export interface ProvidersProps {
  locale: Locale;
  children: ReactNode;
}

export function Providers({ locale, children }: ProvidersProps) {
  const [i18n] = useState(() => createI18n({ locale }));

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A dispatcher watching a board does not want a flicker every time
            // they glance at another window.
            refetchOnWindowFocus: false,
            staleTime: 30_000,
            retry: (failureCount, error) => {
              // Retrying a 401, a 403 or a validation failure achieves nothing
              // and multiplies the log noise. Retry the ones that might be
              // transient.
              const status = (error as { status?: number }).status;
              if (status !== undefined && status >= 400 && status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}
