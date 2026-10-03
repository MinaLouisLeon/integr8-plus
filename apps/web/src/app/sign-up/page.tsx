'use client';

import { useTranslation } from '@integr8/i18n';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { MarketingShell } from '~/components/marketing-shell';
import { Button, Field } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { apiClient } from '~/lib/session';

/**
 * Signing up (P18).
 *
 * Two fields, and then an email. **Nothing is created by this page** — no
 * company, no storage, no trial, no account. All of that happens when the link
 * in the message is followed, which is what makes a bot that never reads mail
 * cost us a row rather than a bucket.
 *
 * The confirmation is deliberately vague about whether anything was sent. The
 * API answers the same way for an address that already has a company as for one
 * that does not, because an endpoint that distinguishes them is an endpoint
 * that enumerates your customers one guess at a time. The person who owns the
 * address finds out in their inbox, which is the only place it is safe to say.
 */
export default function SignUpPage() {
  const { t } = useTranslation();

  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await apiClient().POST('/v1/signup', { body: { email, companyName } });
        setSent(true);
      } catch (failure) {
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  const resend = () => {
    void (async () => {
      try {
        await apiClient().POST('/v1/signup/resend', { body: { email } });
      } catch {
        // Same silence as the send. There is nothing useful to say.
      }
      setResent(true);
    })();
  };

  if (sent) {
    return (
      <MarketingShell>
        <div className="mx-auto flex max-w-md flex-col gap-4 py-12">
          <h1 className="text-2xl font-semibold text-content">{t('signUp.sent')}</h1>
          <p className="text-content-muted">{t('signUp.sentBody', { email })}</p>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={resend}>
              {t('signUp.resend')}
            </Button>
            {resent ? (
              <span className="text-sm text-content-muted">{t('signUp.resent')}</span>
            ) : null}
          </div>
        </div>
      </MarketingShell>
    );
  }

  return (
    <MarketingShell step="signup.opened">
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('signUp.title')}</h1>
          <p className="text-sm text-content-muted">{t('signUp.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field
            label={t('signUp.companyName')}
            hint={t('signUp.companyNameHint')}
            autoComplete="organization"
            required
            maxLength={120}
            value={companyName}
            onChange={(event) => setCompanyName(event.target.value)}
          />
          <Field
            label={t('signUp.email')}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            {...(error === undefined ? {} : { error })}
          />

          <Button type="submit" busy={busy}>
            {busy ? t('signUp.submitting') : t('signUp.submit')}
          </Button>
        </form>

        <p className="text-sm text-content-muted">
          {t('signUp.haveAccount')}{' '}
          <Link href="/sign-in" className="text-accent hover:underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </MarketingShell>
  );
}
