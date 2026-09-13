import { ApiRequestError } from '@integr8/api-client';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Body, Button, Field, Heading, Screen } from '~/components/ui';
import { session } from '~/lib/session';

export default function SignInScreen() {
  const { t } = useTranslation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = () => {
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await session().signInWithPassword({ email, password, deviceLabel: 'Phone' });
        router.replace('/home');
      } catch (failure) {
        setError(messageFor(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Screen>
      <Heading>{t('auth.signInTitle')}</Heading>
      <Body muted>{t('auth.signInSubtitle')}</Body>

      <View style={{ gap: spacing[4] }}>
        <Field
          label={t('auth.email')}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          textContentType="emailAddress"
        />
        <Field
          label={t('auth.password')}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          {...(error === undefined ? {} : { error })}
        />
        <Button
          label={busy ? t('auth.signingIn') : t('auth.signIn')}
          onPress={submit}
          busy={busy}
        />
      </View>
    </Screen>
  );
}

/**
 * The server's message is written for a log; this is the one a person reads.
 *
 * The `code` is the contract, the words are ours, and they are translated. A
 * screen showing an untranslated English sentence to somebody using the app in
 * Arabic is the failure this indirection prevents.
 */
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
