import * as Sentry from '@sentry/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { APP_ENV, APP_VERSION, SENTRY_DSN } from './lib/env';
import { applyRememberedTheme } from './lib/company-theme';
import { applyPreferences, readPreferences } from './lib/preferences';
// The Integr8 Media look's faces, bundled with the app (the staff build wears them).
import '@integr8/tokens/fonts.css';
import './styles.css';

/**
 * Entry point.
 *
 * Preferences are applied to `<html>` before React renders, so a right-to-left
 * layout is right in the first paint rather than snapping into place; the
 * company's theme, remembered from the last launch, is painted the same way so
 * a dark company's app does not flash light while `/v1/me` is asked. Sentry is
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
    // No personal data. Sentry 11 replaced `sendDefaultPii: false` with these
    // per-category switches, and collects every one of them unless told not to.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  });
}

applyPreferences(readPreferences());
applyRememberedTheme();

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
