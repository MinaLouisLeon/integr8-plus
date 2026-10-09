import { ApiRequestError } from '@integr8/api-client';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { useBrand } from '~/components/brand';
import { BrandHeader } from '~/components/brand-header';
import { Body, Button, Field, Heading, Screen } from '~/components/ui';
import { COMPANY } from '~/lib/company';
import { verifySignedInCompany } from '~/lib/company-guard';
import { session } from '~/lib/session';
import { localData } from '~/local/local-data';
import { channelNames, registerForPush } from '~/local/push';

/**
 * Signing in. In a company's own app the form is locked to that company: the
 * slug goes with the request, the API refuses an account from another company
 * (`wrong_company`), and `/v1/me` is checked afterwards all the same.
 */
export default function SignInScreen() {
  const { t } = useTranslation();
  const brand = useBrand();
  // Sent back here after a sign-in that turned out to be another company's account.
  const { notice } = useLocalSearchParams<{ notice?: string }>();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(() =>
    notice === 'wrong_company' ? wrongCompany(t) : undefined,
  );

  const submit = () => {
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        const signedIn = await session().signInWithPassword({
          email,
          password,
          deviceLabel: 'Phone',
          ...(COMPANY === undefined ? {} : { companySlug: COMPANY.slug }),
        });
        // The API already refused another company's account; this is the
        // check that does not trust the sign-in alone. Signing out here sends
        // the app back to the welcome screen, so the message travels as a param.
        if ((await verifySignedInCompany()) === 'wrong_company') {
          router.replace({ pathname: '/sign-in', params: { notice: 'wrong_company' } });
          return;
        }
        // Another person's work on this phone is wiped before anything is shown.
        await localData.prepareFor(signedIn);
        router.replace('/home');
        void localData.sync('launch');
        void registerForPush(channelNames(t));
      } catch (failure) {
        setError(messageFor(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  const back = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/welcome');
    }
  };

  return (
    <Screen>
      {COMPANY === undefined ? null : (
        <View style={{ alignItems: 'flex-start' }}>
          <Button label={t('mobile.back')} variant="secondary" onPress={back} />
        </View>
      )}
      {brand.name === '' ? null : <BrandHeader compact />}
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

function wrongCompany(t: TFunction): string {
  return t('auth.wrongCompany', { company: COMPANY?.name ?? '' });
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
    case 'wrong_company':
      return wrongCompany(t);
    case 'client_too_old':
      return t('errors.clientTooOld');
    default:
      return t('errors.unexpected');
  }
}
