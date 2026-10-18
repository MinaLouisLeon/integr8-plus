import { createI18n, I18nextProvider } from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type Availability, SwitchPanel } from './e-invoicing-switch';

/**
 * Integr8's e-invoicing switch, as staff see it: where it stands, what turns
 * it the other way, and what the server is missing. Nothing here stops the
 * switch; it only says why the company may not see much yet.
 */

function render(state: Availability, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <QueryClientProvider client={new QueryClient()}>
        <SwitchPanel state={state} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

const OFF: Availability = {
  enabled: false,
  financeEnabled: true,
  active: false,
  server: { credentialsKeyConfigured: false, productionAllowed: false },
};

describe('the e-invoicing switch', () => {
  it('starts off, offers to turn it on, and says the server has no key yet', () => {
    const html = render(OFF);
    expect(html).toContain('E-invoicing is off for this company');
    expect(html).toContain('Turn e-invoicing on');
    expect(html).toContain('has not been tested with the tax authority yet');
    expect(html).toContain('This server has no ETA_CREDENTIALS_KEY');
    expect(html).toContain('Production is locked on this server');
  });

  it('says when it is on but the finance module it needs is off', () => {
    const html = render({
      ...OFF,
      enabled: true,
      financeEnabled: false,
      server: { credentialsKeyConfigured: true, productionAllowed: false },
    });
    expect(html).toContain('the Finance module it needs is off');
    expect(html).toContain('Turn e-invoicing off');
    expect(html).toContain('This server has the key');
  });

  it('reads in Arabic', () => {
    const html = render({ ...OFF, enabled: true, active: true }, 'ar');
    expect(html).toContain('الفاتورة الإلكترونية مفعّلة لهذه الشركة.');
    expect(html).toContain('إطفاء الفاتورة الإلكترونية');
  });
});
