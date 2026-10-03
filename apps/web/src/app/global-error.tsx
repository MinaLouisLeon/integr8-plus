'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

/**
 * The last resort.
 *
 * Next renders this when a render itself threw, which means no provider is
 * available — so the copy here cannot come from the translation layer. It is
 * the one place in this app where a literal string is correct, and it is
 * deliberately short.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          minHeight: '100dvh',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
          textAlign: 'center',
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>Something went wrong</h1>
          <p style={{ color: '#64748b' }}>
            Please reload the page. If it keeps happening, quote this reference:{' '}
            <code>{error.digest ?? 'unknown'}</code>
          </p>
        </div>
      </body>
    </html>
  );
}
