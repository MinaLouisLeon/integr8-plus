import * as Sentry from '@sentry/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { APP_ENV, APP_VERSION, SENTRY_DSN } from './lib/env';
import { applyPreferences, readPreferences } from './lib/preferences';
import './styles.css';

/**
 * Entry point.
 *
 * Preferences are applied to `<html>` before React renders, so a right-to-left
 * layout is right in the first paint rather than snapping into place. Sentry is
 * initialised first, so an error thrown during startup is still reported.
 */

if (SENTRY_DSN !== undefined && SENTRY_DSN !== '') {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: APP_ENV,
    // The release tag is what makes an error bisectable, and what P05's fourth
    // exit criterion is about.
    release: APP_VERSION,
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

applyPreferences(readPreferences());

const container = document.getElementById('root');
if (container === null) {
  throw new Error('No #root element; index.html and main.tsx disagree.');
}

createRoot(container).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        // Rendered when the tree itself threw, so no provider is available and
        // the translation layer cannot be reached. The one place in this app
        // where a literal string is correct.
        <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
          <h1>Something went wrong</h1>
          <p>Please restart the app. The problem has been reported.</p>
        </div>
      }
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
