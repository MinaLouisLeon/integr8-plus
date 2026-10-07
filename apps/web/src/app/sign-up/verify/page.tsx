'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { MarketingShell } from '~/components/marketing-shell';
import { SignupClosed } from '~/components/signup-closed';
import { Button, Field, LoadingState } from '~/components/ui';
import { apiClient, signIn } from '~/lib/session';
import { signupMode } from '~/lib/signup';

/**
 * Where the company is actually created (P18).
 *
 * Everything the signup page promised happens here and nowhere else: the
 * account at the identity provider, the company, its job types, its storage
 * bucket and its trial. That ordering is why a signup nobody verifies costs a
 * single row and expires quietly.
 *
 * Refuses expired, spent and unknown links with one message. Distinguishing
 * them would tell a stranger which addresses have signed up.
 */
export default function VerifySignupPage() {
  if (signupMode() !== 'open') {
    return <SignupClosed />;
  }

  return (
    <Suspense fallback={<LoadingState />}>
      <VerifySignupForm />
    </Suspense>
  );
}

function VerifySignupForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        const { data } = await apiClient().POST('/v1/signup/verify', {
          body: { token, displayName, password },
        });

        if (data !== undefined) {
          try {
            // Verification hands back no session, for the same reason accepting
            // an invitation does not: this link may be sitting in a mailbox.
            // Signing in with the password just chosen grants nothing extra.
            await signIn(data.email, password);
            router.push('/dashboard');
            return;
          } catch {
            setError(t('signUp.verify.signInFailed'));
            return;
          }
        }
      } catch {
        setError(t('signUp.verify.invalid'));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (token === '') {
    return (
      <MarketingShell>
        <div className="mx-auto flex max-w-md flex-col gap-4 py-12">
          <h1 className="text-2xl font-semibold text-content">{t('signUp.verify.title')}</h1>
          <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
            {t('signUp.verify.missingToken')}
          </p>
        </div>
      </MarketingShell>
    );
  }

  return (
    <MarketingShell>
      <div className="mx-auto flex max-w-md flex-col gap-6 py-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">{t('signUp.verify.title')}</h1>
          <p className="text-sm text-content-muted">{t('signUp.verify.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field
            label={t('signUp.verify.displayName')}
            autoComplete="name"
            required
            maxLength={120}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Field
            label={t('signUp.verify.password')}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...(error === undefined ? {} : { error })}
          />

          <Button type="submit" busy={busy}>
            {busy ? t('signUp.verify.submitting') : t('signUp.verify.submit')}
          </Button>
        </form>
      </div>
    </MarketingShell>
  );
}
