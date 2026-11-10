// First: before any form is checked (see the file).
import './no-eval.js';
import { openPickersOnClick } from '@integr8/form-renderer-dom';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { windowApi } from './api.js';
import { App } from './app.js';

/**
 * The preview window's entry point, bundled by `scripts/bundle.mjs` into
 * dist/window/page.js. The token the server checks comes from the page's own
 * address; every request the page makes carries it.
 */

const token = new URLSearchParams(window.location.search).get('k') ?? '';
const container = document.getElementById('root');
if (container !== null) {
  // A click anywhere on a date or time box opens its picker, as in the apps.
  openPickersOnClick();
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={createI18n({ locale: 'en' })}>
        <App
          api={windowApi(token)}
          blank={new URLSearchParams(window.location.search).has('blank')}
        />
      </I18nextProvider>
    </StrictMode>,
  );
}
