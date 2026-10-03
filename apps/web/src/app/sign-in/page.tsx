'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { signIn } from '~/lib/session';

/**
 * Sign in.
 *
 * Every string comes from the translation layer, including the failure
 * messages. The API's messages are not shown directly: they are written for a
 * developer reading a log, and a person needs the one their own app author
 * chose.
 */
export default function SignInPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await signIn(email, password);
        router.push('/dashboard');
      } catch (failure) {
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('auth.signInTitle')}</h1>
        <p className="text-sm text-content-muted">{t('auth.signInSubtitle')}</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('auth.email')}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Field
          label={t('auth.password')}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...(error === undefined ? {} : { error })}
        />
        <Button type="submit" busy={busy}>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>
    </main>
  );
}
