'use client';

import { useTranslation } from '@integr8/i18n';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type ComponentProps, type FormEvent } from 'react';
import { Button, Field, LoadingState } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { apiClient } from '~/lib/api-client';
import { InvitationDone } from './done';

/**
 * Accepting an invitation (P18; Low 5, 1.2.4).
 *
 * **This page is why P18 started here.** The API has minted
 * `/accept-invitation?token=…` links since P15 — from onboarding, from the
 * platform's resend, and from the invitation email P18 added — and until then
 * the URL was a 404.
 *
 * The token in the query string is a capability: whoever holds it becomes a
 * member at the role it was issued for. So the page asks for nothing it does
 * not need, tells a stranger nothing about whether the link was ever real, and
 * never puts the token anywhere but a request body.
 *
 * It first asks the API what accepting will need: an address with no sign-in
 * yet chooses a password here, and one that already signs in (another
 * company's member) does not. Accepting signs nobody in. The page ends by
 * saying the password is set (or that they have joined, for an existing
 * sign-in) and sends the person to their company's desktop or phone app, with
 * its installers from the API's answer (P42): there is no web workspace to
 * sign in to, and no public download page any more. An owner is invited only
 * once the company's desktop app exists (D6), so there is something to list.
 */
export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AcceptInvitationForm />
    </Suspense>
  );
}

interface Invitation {
  email: string;
  passwordRequired: boolean;
}

function AcceptInvitationForm() {
  const { t } = useTranslation();
  const token = useSearchParams().get('token') ?? '';

  const [invitation, setInvitation] = useState<Invitation | 'invalid' | undefined>(undefined);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<ComponentProps<typeof InvitationDone>['done'] | undefined>(
    undefined,
  );

  useEffect(() => {
    if (token === '') {
      return;
    }
    let current = true;
    void (async () => {
      try {
        const { data } = await apiClient().POST('/v1/invitations/inspect', { body: { token } });
        if (current) {
          setInvitation(data ?? 'invalid');
        }
      } catch {
        // Expired, withdrawn, already accepted and never-existed are one
        // message, as at acceptance.
        if (current) {
          setInvitation('invalid');
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [token]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invitation === undefined || invitation === 'invalid') {
      return;
    }

    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        const { data } = await apiClient().POST('/v1/invitations/accept', {
          body: {
            token,
            displayName,
            // Only when one is being chosen: an existing sign-in keeps its own.
            ...(invitation.passwordRequired ? { password } : {}),
            clientApp: 'web',
          },
        });
        if (data !== undefined) {
          setDone({
            email: data.email,
            existingAccount: data.existingAccount,
            company: data.company,
            apps: data.apps,
          });
        }
      } catch (failure) {
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (token === '' || invitation === 'invalid') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-4 px-6">
        <h1 className="text-2xl font-semibold text-content">{t('auth.accept.title')}</h1>
        <p role="alert" className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {token === '' ? t('auth.accept.missingToken') : t('auth.accept.invalid')}
        </p>
      </main>
    );
  }

  if (invitation === undefined) {
    return <LoadingState />;
  }

  if (done !== undefined) {
    return <InvitationDone done={done} />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">{t('auth.accept.title')}</h1>
        <p className="text-sm text-content-muted">
          {invitation.passwordRequired
            ? t('auth.accept.subtitle')
            : t('auth.accept.subtitleExisting')}
        </p>
        <p className="text-sm text-content">
          {t('auth.accept.invitedAs', { email: invitation.email })}
        </p>
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
          {...(error === undefined || invitation.passwordRequired ? {} : { error })}
        />
        {invitation.passwordRequired ? (
          <Field
            label={t('auth.accept.choosePassword')}
            hint={t('auth.accept.passwordHint')}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            {...(error === undefined ? {} : { error })}
          />
        ) : null}

        <Button type="submit" busy={busy}>
          {busy ? t('auth.accept.accepting') : t('auth.accept.submit')}
        </Button>
      </form>
    </main>
  );
}
