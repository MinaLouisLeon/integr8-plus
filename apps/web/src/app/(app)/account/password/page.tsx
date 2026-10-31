'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field } from '~/components/ui';
import { messageForError } from '~/lib/errors';
import { changePassword, mayChangePasswordWithoutCurrent } from '~/lib/session';

/**
 * Change password (P36).
 *
 * For fifteen minutes after signing in with an emailed code the current
 * password is not asked for: that is the way back in for somebody who has
 * forgotten it. The API makes the decision; if the window has passed it says
 * so, and the field comes back.
 *
 * After a change every other device is signed out by the API. This tab keeps
 * its session.
 */
export default function ChangePasswordPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();

  const [needsCurrent, setNeedsCurrent] = useState(() => !mayChangePasswordWithoutCurrent());
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const locale = language === 'ar' ? 'ar' : 'en';

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
        await changePassword({ currentPassword: current, newPassword: next, locale });
        setDone(true);
        setCurrent('');
        setNext('');
        setConfirm('');
      } catch (failure) {
        if (
          failure instanceof ApiRequestError &&
          failure.code === 'auth.current_password_required'
        ) {
          setNeedsCurrent(true);
        }
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold text-content">{t('auth.changePassword.title')}</h1>

      {done ? (
        <p role="status" className="text-sm text-content">
          {t('auth.changePassword.done')}
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {needsCurrent ? (
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
            hint={t('auth.changePassword.hint')}
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(event) => setNext(event.target.value)}
          />
          <Field
            label={t('auth.changePassword.confirm')}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            {...(error === undefined ? {} : { error })}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              busy={busy}
              disabled={next === '' || confirm === '' || (needsCurrent && current === '')}
            >
              {busy ? t('auth.changePassword.saving') : t('auth.changePassword.submit')}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => router.back()}>
              {t('auth.changePassword.cancel')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
