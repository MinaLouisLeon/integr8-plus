import { ApiRequestError } from '@integr8/api-client';
import { apiErrorMessage, type TFunction, useTranslation } from '@integr8/i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button, Field } from '~/components/ui';
import { staffSignIn } from './session';

/**
 * Integr8 staff signing in to the staff app (P42): a platform account's
 * password and authenticator code, every time the app starts (the session is
 * kept in memory only, D2), and then the staff dashboard. Companies are opened
 * from there, from a company's page.
 *
 * Loaded lazily by the sign-in screen, so a company's build carries none of it.
 */
export default function StaffSignIn() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
        await staffSignIn({ email, password, code });
        void navigate('/platform', { replace: true });
      } catch (failure) {
        setError(messageFor(failure, t));
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <div className="flex flex-col gap-1 text-start">
        <h1 className="text-2xl font-semibold text-content">{t('auth.staff.title')}</h1>
        <p className="text-sm text-content-muted">{t('auth.staff.subtitle')}</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('auth.email')}
          type="email"
          autoComplete="username"
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
        />
        <Field
          label={t('auth.staff.code')}
          placeholder={t('auth.staff.codeHint')}
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          minLength={6}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          {...(error === undefined ? {} : { error })}
        />
        <Button type="submit" busy={busy}>
          {busy ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>
    </>
  );
}

/** The server's message is for a log; this is the one a person reads. */
function messageFor(failure: unknown, t: TFunction): string {
  if (!(failure instanceof ApiRequestError)) {
    return failure instanceof TypeError ? t('errors.offline') : t('errors.unexpected');
  }
  // A wrong email, password or code is a plain 401, and says no more on purpose.
  return failure.status === 401 ? t('auth.invalidCredentials') : apiErrorMessage(failure, t);
}
