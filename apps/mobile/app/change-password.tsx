import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { onlineFailureMessage } from '~/components/online';
import { Body, Button, Field, Heading, ScrollScreen } from '~/components/ui';
import { session } from '~/lib/session';
import { isOnline } from '~/local/online';

/**
 * Change password (P36), from Settings.
 *
 * Needs the current password, except in the fifteen minutes after signing in
 * with an emailed code — the way back in for somebody who has forgotten it —
 * when the field is left out. The API decides either way: if the window has
 * passed it answers `auth.current_password_required` and the field comes back.
 *
 * Every other device is signed out by the API, offline access included; this
 * phone keeps its session and its work. Online only: a password is not a
 * change that can wait in the outbox.
 */
export default function ChangePasswordScreen() {
  const { t, i18n } = useTranslation();
  const [needsCurrent, setNeedsCurrent] = useState(
    () => !session().mayChangePasswordWithoutCurrent(),
  );
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState(false);

  const submit = () => {
    if (next !== confirm) {
      setError(t('auth.changePassword.mismatch'));
      return;
    }
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        if (!(await isOnline())) {
          setError(t('mobile.online.neededBody'));
          return;
        }
        await session().changePassword({
          newPassword: next,
          ...(needsCurrent ? { currentPassword: current } : {}),
          locale: i18n.language.startsWith('ar') ? 'ar' : 'en',
        });
        setDone(true);
      } catch (failure) {
        if (
          failure instanceof ApiRequestError &&
          failure.code === 'auth.current_password_required'
        ) {
          setNeedsCurrent(true);
        }
        setError(onlineFailureMessage(t, failure));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>
      <Heading>{t('auth.changePassword.title')}</Heading>

      {done ? (
        <View style={{ gap: spacing[4] }}>
          <Body>{t('auth.changePassword.done')}</Body>
          <Button label={t('mobile.back')} onPress={() => router.back()} />
        </View>
      ) : (
        <View style={{ gap: spacing[4] }}>
          {needsCurrent ? (
            <Field
              label={t('auth.changePassword.current')}
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
            />
          ) : (
            <Body muted>{t('auth.changePassword.afterCode')}</Body>
          )}
          <Field
            label={t('auth.changePassword.new')}
            value={next}
            onChangeText={setNext}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
          />
          <Field
            label={t('auth.changePassword.confirm')}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            {...(error === undefined ? {} : { error })}
          />
          <Body muted>{t('auth.changePassword.hint')}</Body>
          <Button
            label={busy ? t('auth.changePassword.saving') : t('auth.changePassword.submit')}
            onPress={submit}
            busy={busy}
            disabled={next === '' || (needsCurrent && current === '')}
          />
          <Button
            label={t('auth.changePassword.cancel')}
            variant="secondary"
            onPress={() => router.back()}
          />
        </View>
      )}
    </ScrollScreen>
  );
}
