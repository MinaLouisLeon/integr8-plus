import { createI18n, I18nextProvider } from '@integr8/i18n';
import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InvitationDone } from './done';

/**
 * Accepting an invitation ends on the public site (P42): the password is set,
 * and the way on is the company's own apps, never a web sign-in. The
 * installers are listed here, from the API's answer, and nowhere else.
 */

type Apps = ComponentProps<typeof InvitationDone>['done']['apps'];

const FOUND: Apps = {
  status: 'found',
  release: {
    tag: 'company-nile-v2.1.0',
    version: '2.1.0',
    installers: [
      {
        name: 'Nile Services_2.1.0_x64-setup.exe',
        url: 'https://app.integr8-media.com/desktop-updates/nile/download/company-nile-v2.1.0/Nile.Services_2.1.0_x64-setup.exe',
        platform: 'windows',
        kind: 'exe',
        arch: 'x64',
        size: 12_400_000,
      },
      {
        name: 'nile.apk',
        url: 'https://app.integr8-media.com/desktop-updates/nile/download/company-nile-v2.1.0/nile.apk',
        platform: 'android',
        kind: 'apk',
        arch: null,
        size: null,
      },
    ],
  },
};

function render(
  existingAccount: boolean,
  { locale = 'en', apps = FOUND }: { locale?: 'en' | 'ar'; apps?: Apps } = {},
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <InvitationDone
        done={{
          email: 'omar@nile.example',
          existingAccount,
          company: { name: 'Nile Services', slug: 'nile' },
          apps,
        }}
      />
    </I18nextProvider>,
  );
}

describe('the invitation page’s last step', () => {
  it('says the password is set and lists the company’s installers', () => {
    const html = render(false);
    expect(html).toContain('Your password is set');
    expect(html).toContain('omar@nile.example');
    expect(html).toContain('Version 2.1.0');
    expect(html).toContain('/desktop-updates/nile/download/company-nile-v2.1.0/');
    expect(html).toContain('Android app (.apk)');
    expect(html).toContain('shown only here');
    expect(html).not.toContain('/download?company');
    expect(html).not.toContain('/sign-in');
  });

  it('says when nothing is published, or the list cannot be read just now', () => {
    expect(render(false, { apps: { status: 'none' } })).toContain('have not been published yet');
    expect(render(false, { apps: { status: 'unavailable' } })).toContain(
      'Ask your office or Integr8 to send you the installer',
    );
  });

  it('tells somebody who already signs in that they have joined', () => {
    const html = render(true);
    expect(html).toContain('You have joined');
    expect(html).toContain('the password you already use');
  });

  it('reads in Arabic', () => {
    expect(render(false, { locale: 'ar' })).toContain('عُيّنت كلمة المرور');
  });
});
