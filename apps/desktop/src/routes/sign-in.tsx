import { ApiRequestError } from '@integr8/api-client';
import { useTranslation, type TFunction } from '@integr8/i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field, Shell } from '~/components/ui';
import { session } from '~/lib/session';

export function SignInRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

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
        await session().signInWithPassword({ email, password, deviceLabel: 'Desktop' });
        void navigate('/dashboard', { replace: true });
      } catch (failure) {
        setError(messageFor(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Shell>
      <div className="mx-auto flex w-full max-w-sm flex-col justify-center gap-6">
        <div className="flex flex-col gap-1 text-start">
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
      </div>
    </Shell>
  );
}

/** The server's message is for a log; this is the one a person reads. */
function messageFor(failure: unknown, t: TFunction): string {
  if (!(failure instanceof ApiRequestError)) {
    return t('errors.unexpected');
  }

  switch (failure.code) {
    case 'auth.invalid_credentials':
      return t('auth.invalidCredentials');
    case 'auth.account_locked':
      return t('auth.accountLocked');
    case 'auth.rate_limited':
    case 'rate_limited':
      return t('auth.rateLimited');
    case 'client_too_old':
      return t('errors.clientTooOld');
    default:
      return t('errors.unexpected');
  }
}
