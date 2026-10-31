import { ApiRequestError } from '@integr8/api-client';
import { createI18n, I18nextProvider } from '@integr8/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ChangePasswordForm } from './change-password';
import { CodeSignIn, codeFailureMessage, uiLocale } from './sign-in';

/**
 * Signing in with an emailed code, and Change password (P36), as the desktop
 * shows them.
 */

function render(node: React.ReactNode, locale: 'en' | 'ar' = 'en'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={createI18n({ locale })}>
      <MemoryRouter>{node}</MemoryRouter>
    </I18nextProvider>,
  );
}

const refusal = (status: number, code: string) => new ApiRequestError(status, code, 'x', 'req');

describe('the code step', () => {
  it('says where the code went, and offers a new one or the password', () => {
    const html = render(
      <CodeSignIn email="dana@example.com" companyName="" onBack={() => undefined} />,
    );
    expect(html).toContain('Enter your sign-in code');
    expect(html).toContain('dana@example.com');
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('Send a new code');
    expect(html).toContain('Sign in with a password instead');
  });

  it('gives one message for every failure but a lock and another company', () => {
    const { t } = createI18n({ locale: 'en' });
    const failed = codeFailureMessage(refusal(401, 'auth.invalid_credentials'), t, 'Acme');
    expect(codeFailureMessage(refusal(400, 'invalid_body'), t, 'Acme')).toBe(failed);
    expect(codeFailureMessage(refusal(423, 'auth.account_locked'), t, 'Acme')).not.toBe(failed);
    expect(codeFailureMessage(refusal(403, 'wrong_company'), t, 'Acme')).toContain('Acme');
  });

  it('asks for the email in the language on screen', () => {
    expect(uiLocale('ar')).toBe('ar');
    expect(uiLocale('en-GB')).toBe('en');
  });
});

describe('Change password', () => {
  it('asks for the current password after a password sign-in', () => {
    const html = render(<ChangePasswordForm withoutCurrent={false} />);
    expect(html).toContain('Current password');
    expect(html).toContain('New password again');
  });

  it('leaves it out just after a code sign-in, and says why', () => {
    const html = render(<ChangePasswordForm withoutCurrent />);
    expect(html).not.toContain('Current password');
    expect(html).toContain('signed in with an emailed code');
  });

  it('reads right to left in Arabic, with logical classes only', () => {
    const html = render(<ChangePasswordForm withoutCurrent={false} />, 'ar');
    expect(html).toContain('كلمة المرور الحالية');
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right)-\d/u);
  });
});
