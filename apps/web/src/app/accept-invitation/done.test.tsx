import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InvitationDone } from './done';

/**
 * Accepting an invitation ends on the public site (P42): the password is set,
 * and the way on is the company's own apps, never a web sign-in.
 */

function render(existingAccount: boolean, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <InvitationDone
        done={{
          email: 'omar@nile.example',
          existingAccount,
          company: { name: 'Nile Services', slug: 'nile' },
        }}
      />
    </I18nextProvider>,
  );
}

describe('the invitation page’s last step', () => {
  it('says the password is set and leads to the company’s apps', () => {
    const html = render(false);
    expect(html).toContain('Your password is set');
    expect(html).toContain('omar@nile.example');
    expect(html).toContain('href="/download?company=nile"');
    expect(html).not.toContain('/sign-in');
  });

  it('tells somebody who already signs in that they have joined', () => {
    const html = render(true);
    expect(html).toContain('You have joined');
    expect(html).toContain('the password you already use');
  });

  it('reads in Arabic', () => {
    expect(render(false, 'ar')).toContain('عُيّنت كلمة المرور');
  });
});
