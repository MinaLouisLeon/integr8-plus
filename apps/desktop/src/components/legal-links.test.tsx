import { ar, createI18n, en, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LegalLinks } from './legal-links';

/**
 * Under the sign-in form (High 10): the three legal pages, on the operator's
 * website, opened outside the app window.
 */

function render(locale: 'en' | 'ar'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <LegalLinks />
    </I18nextProvider>,
  );
}

describe('the legal links', () => {
  it('point at the published pages, outside the app', () => {
    const html = render('en');
    expect(html).toContain('href="https://app.integr8-media.com/legal/terms"');
    expect(html).toContain('href="https://app.integr8-media.com/legal/privacy"');
    expect(html).toContain('href="https://app.integr8-media.com/legal/dpa"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(en.legal.documents.privacy);
  });

  it('are named in Arabic on an Arabic screen', () => {
    const html = render('ar');
    expect(html).toContain(ar.legal.documents.privacy);
    expect(html).toContain(`aria-label="${ar.legal.nav}"`);
  });
});
