import { ApiRequestError } from '@integr8/api-client';
import { apiErrorMessage, type TFunction, useTranslation } from '@integr8/i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useShellChrome } from '~/components/shell-chrome';
import { Button, Field, Shell } from '~/components/ui';
import { session } from '~/lib/session';

/**
 * Change password (P36), from the account menu.
 *
 * The current password is asked for unless this app signed in with an emailed
 * code in the last fifteen minutes — the way back in for somebody who has
 * forgotten it. That is only a hint: the API decides, and if the window has
 * passed it answers `auth.current_password_required`, and the field appears.
 *
 * The API signs out every other device; this one stays signed in.
 */
export function ChangePasswordRoute() {
  const { t } = useTranslation();
  useShellChrome({ title: t('auth.changePassword.title') });

  return (
    <Shell>
      <div className="w-full max-w-md px-6 py-8">
        <ChangePasswordForm />
      </div>
    </Shell>
  );
}

export function ChangePasswordForm({
  withoutCurrent = session().mayChangePasswordWithoutCurrent(),
}: {
  withoutCurrent?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [askCurrent, setAskCurrent] = useState(!withoutCurrent);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (next !== confirm) {
      setError(t('auth.changePassword.mismatch'));
      return;
    }
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await session().changePassword({
          newPassword: next,
          ...(askCurrent ? { currentPassword: current } : {}),
          locale: i18n.language.startsWith('ar') ? 'ar' : 'en',
        });
        setDone(true);
      } catch (failure) {
        if (
          failure instanceof ApiRequestError &&
          failure.code === 'auth.current_password_required'
        ) {
          setAskCurrent(true);
        }
        setError(messageFor(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (done) {
    return (
      <div className="flex flex-col gap-4 text-start">
        <h1 className="text-2xl font-semibold text-content">{t('auth.changePassword.title')}</h1>
        <p role="status" className="text-sm text-content">
          {t('auth.changePassword.done')}
        </p>
        <div>
          <Button type="button" onClick={() => void navigate('/dashboard')}>
            {t('nav.backTo', { title: t('nav.section.dashboard') })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 text-start" noValidate>
      <h1 className="text-2xl font-semibold text-content">{t('auth.changePassword.title')}</h1>

      {askCurrent ? (
        <Field
          label={t('auth.changePassword.current')}
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
      ) : (
        <p className="text-sm text-content-muted">{t('auth.changePassword.afterCode')}</p>
      )}

      <Field
        label={t('auth.changePassword.new')}
        type="password"
        autoComplete="new-password"
        required
        value={next}
        onChange={(event) => setNext(event.target.value)}
      />
      <p className="-mt-2 text-xs text-content-muted">{t('auth.changePassword.hint')}</p>
      <Field
        label={t('auth.changePassword.confirm')}
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        {...(error === undefined ? {} : { error })}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          busy={busy}
          disabled={next === '' || confirm === '' || (askCurrent && current === '')}
        >
          {busy ? t('auth.changePassword.saving') : t('auth.changePassword.submit')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => void navigate(-1)}>
          {t('auth.changePassword.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The catalogue's words for the API's code (ADR-0012); the server's message is for a log. */
function messageFor(failure: unknown, t: TFunction): string {
  if (!(failure instanceof ApiRequestError)) {
    return failure instanceof TypeError ? t('errors.offline') : t('errors.unexpected');
  }
  return apiErrorMessage(failure, t);
}
