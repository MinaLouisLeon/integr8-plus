import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ClientTooOldBanner } from '~/components/client-too-old-banner';
import {
  currentUpdateNotice,
  reportClientTooOld,
  resetUpdateNotice,
  subscribeToUpdateNotice,
  updateLinkFor,
} from './client-update';

/**
 * A desktop app the server no longer serves (Low 6): the strip says so and its
 * Update button opens the download page, with the company filled in for a
 * company's own build. The app usually updates itself first; this is the way
 * out when it has not.
 */

const PAGE = 'https://app.integr8-media.com/download';

function render(node: React.ReactNode, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>{node}</I18nextProvider>,
  );
}

describe('the Update button on a desktop app too old to be served', () => {
  afterEach(() => {
    resetUpdateNotice();
  });

  it("opens the company's page in a company build, and the plain page in the staff app", () => {
    expect(updateLinkFor(PAGE, 'acme')).toBe(`${PAGE}?company=acme`);
    expect(updateLinkFor(PAGE, undefined)).toBe(PAGE);
    expect(updateLinkFor(undefined, 'acme')).toBeUndefined();
  });

  it('is reported once, whichever request found out', () => {
    let told = 0;
    const stop = subscribeToUpdateNotice(() => {
      told += 1;
    });
    reportClientTooOld({ minimum: '2.0.0', message: 'Update', updateUrl: PAGE }, undefined);
    reportClientTooOld({ minimum: '2.0.0', message: 'Update', updateUrl: PAGE }, undefined);
    expect(currentUpdateNotice()).toEqual({ link: PAGE });
    expect(told).toBe(1);
    stop();
  });

  it('shows nothing until the server has refused this build', () => {
    expect(render(<ClientTooOldBanner />)).toBe('');
  });

  it('shows the message and a link out of the window, in English and Arabic', () => {
    const notice = { link: `${PAGE}?company=acme` };
    const html = render(<ClientTooOldBanner notice={notice} />);
    expect(html).toContain('no longer supported');
    expect(html).toContain(`href="${PAGE}?company=acme"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('>Update<');

    const arabic = render(<ClientTooOldBanner notice={notice} />, 'ar');
    expect(arabic).toContain('تحديث');
  });

  it('has no button when the server gave no address', () => {
    const html = render(<ClientTooOldBanner notice={{ link: undefined }} />);
    expect(html).toContain('no longer supported');
    expect(html).not.toContain('<a');
  });
});
