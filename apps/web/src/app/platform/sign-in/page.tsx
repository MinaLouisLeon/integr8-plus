'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { signInToPlatform } from '~/lib/platform-session';

/**
 * Signing in to the dashboard (P15).
 *
 * Outside the guarded group, and outside the customer sign-in: a different
 * form, a different endpoint, a different cookie. Both factors are asked for
 * together on one screen rather than in two steps, because a second step would
 * have to be reachable by anybody who got the password right — which tells them
 * they got the password right.
 */
export default function PlatformSignInPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await signInToPlatform(email, password, code);
        router.push('/platform');
      } catch (failure) {
        setError(
          failure instanceof ApiRequestError && failure.code === 'auth.account_locked'
            ? t('platform.signIn.locked')
            : messageForError(failure, t),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('platform.signIn.title')}</h1>
        <p className="text-sm text-content-muted">{t('platform.signIn.subtitle')}</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('platform.signIn.email')}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label={t('platform.signIn.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Field
          label={t('platform.signIn.code')}
          hint={t('platform.signIn.codeHint')}
          // `one-time-code` is what makes a phone offer the code from the
          // notification rather than the person copying six digits by hand.
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replaceAll(/\D/gu, ''))}
          {...(error === undefined ? {} : { error })}
        />
        <Button type="submit" busy={busy}>
          {busy ? t('platform.signIn.busy') : t('platform.signIn.submit')}
        </Button>
      </form>
    </main>
  );
}
