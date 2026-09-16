'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Button, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { apiClient, signIn } from '~/lib/session';

/**
 * Accepting an invitation (P18).
 *
 * **This page is why P18 started here.** The API has minted
 * `/accept-invitation?token=…` links since P15 — from onboarding, from the
 * platform's resend, and from the invitation email P18 added — and until now
 * the URL was a 404. Every invitation this product has ever produced led
 * nowhere.
 *
 * The token in the query string is a capability: whoever holds it becomes a
 * member at the role it was issued for. So the page asks for nothing it does
 * not need, tells a stranger nothing about whether the link was ever real, and
 * never puts the token anywhere but the request body.
 */
export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AcceptInvitationForm />
    </Suspense>
  );
}

function AcceptInvitationForm() {
  const { t } = useTranslation();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (token === '') {
      setError(t('auth.accept.missingToken'));
      return;
    }

    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        const { data } = await apiClient().POST('/v1/invitations/accept', {
          body: { token, displayName, password, clientApp: 'web' },
        });

        // Accepting deliberately hands back no session — see the route. The
        // account exists now, so this is an ordinary sign-in with the password
        // they chose a moment ago, which grants nothing a token-holder could
        // not already have taken.
        if (data !== undefined) {
          try {
            await signIn(data.email, password);
            router.push('/dashboard');
            return;
          } catch {
            // The membership is real either way. Sending them to sign in is a
            // worse ending than the redirect, but it is an honest one.
            setError(t('auth.accept.signInFailed'));
            return;
          }
        }
      } catch (failure) {
        // Expired, withdrawn, already accepted and never-existed are one
        // message. Distinguishing them would confirm to a stranger that a link
        // they found was once real.
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (token === '') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
        <h1 className="text-2xl font-semibold text-content">{t('auth.accept.title')}</h1>
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {t('auth.accept.missingToken')}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('auth.accept.title')}</h1>
        <p className="text-sm text-content-muted">{t('auth.accept.subtitle')}</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('auth.accept.displayName')}
          hint={t('auth.accept.displayNameHint')}
          autoComplete="name"
          required
          maxLength={120}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Field
          label={t('auth.accept.choosePassword')}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          {...(error === undefined ? {} : { error })}
        />

        <Button type="submit" busy={busy}>
          {busy ? t('auth.accept.accepting') : t('auth.accept.submit')}
        </Button>
      </form>
    </main>
  );
}
