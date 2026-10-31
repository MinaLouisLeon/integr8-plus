import type { SignInResult } from '@integr8/api-client';
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
import { codeRequestFailureMessage, signInFailureMessage } from '~/lib/sign-in-messages';
import { localData } from '~/local/local-data';
import { channelNames, registerForPush } from '~/local/push';

/**
 * Signing in, with a password or with a 6-digit code emailed to the address
 * (P36) — the way back in for somebody who has forgotten their password. In a
 * company's own app both are locked to that company: the slug goes with the
 * request, the API refuses an account from another company (`wrong_company`),
 * and `/v1/me` is checked afterwards all the same.
 */
export default function SignInScreen() {
  const { t, i18n } = useTranslation();
  const brand = useBrand();
  // Sent back here after a sign-in that turned out to be another company's account.
  const { notice } = useLocalSearchParams<{ notice?: string }>();

  const [step, setStep] = useState<'password' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [info, setInfo] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(() =>
    notice === 'wrong_company' ? wrongCompany(t) : undefined,
  );

  const locale = i18n.language.startsWith('ar') ? 'ar' : 'en';
  const lock = COMPANY === undefined ? {} : { companySlug: COMPANY.slug };
  const companyName = COMPANY?.name ?? '';

  /** Both ways in end here, so the checks and the clean start cannot drift apart. */
  const finish = async (signedIn: SignInResult) => {
    // The API already refused another company's account; this is the check
    // that does not trust the sign-in alone. Signing out here sends the app
    // back to the welcome screen, so the message travels as a param.
    if ((await verifySignedInCompany()) === 'wrong_company') {
      router.replace({ pathname: '/sign-in', params: { notice: 'wrong_company' } });
      return;
    }
    // Another person's work on this phone is wiped before anything is shown.
    await localData.prepareFor(signedIn);
    router.replace('/home');
    void localData.sync('launch');
    void registerForPush(channelNames(t));
  };

  const submitPassword = () => {
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await finish(
          await session().signInWithPassword({ email, password, deviceLabel: 'Phone', ...lock }),
        );
      } catch (failure) {
        setError(signInFailureMessage(failure, t, { companyName }));
      } finally {
        setBusy(false);
      }
    })();
  };

  const sendCode = (again: boolean) => {
    if (email.trim() === '') {
      setError(t('auth.code.needEmail'));
      return;
    }
    setSending(true);
    setError(undefined);
    setInfo(undefined);

    void (async () => {
      try {
        await session().requestSignInCode(email.trim(), locale);
        setStep('code');
        setInfo(again ? t('auth.code.resent') : t('auth.code.sent', { email: email.trim() }));
      } catch (failure) {
        setError(codeRequestFailureMessage(failure, t));
      } finally {
        setSending(false);
      }
    })();
  };

  const submitCode = () => {
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await finish(
          await session().signInWithCode({
            email: email.trim(),
            code: code.trim(),
            deviceLabel: 'Phone',
            ...lock,
          }),
        );
      } catch (failure) {
        setError(signInFailureMessage(failure, t, { companyName, withCode: true }));
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

      {step === 'password' ? (
        <>
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
              onPress={submitPassword}
              busy={busy}
            />
            <Button
              label={t('auth.code.request')}
              variant="secondary"
              busy={sending}
              onPress={() => sendCode(false)}
            />
          </View>
        </>
      ) : (
        <>
          <Heading>{t('auth.code.title')}</Heading>
          {info === undefined ? null : <Body muted>{info}</Body>}

          <View style={{ gap: spacing[4] }}>
            <Field
              label={t('auth.code.label')}
              placeholder={t('auth.code.hint')}
              value={code}
              onChangeText={(value) => setCode(value.replace(/\D/gu, '').slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              {...(error === undefined ? {} : { error })}
            />
            <Button
              label={busy ? t('auth.signingIn') : t('auth.code.submit')}
              onPress={submitCode}
              busy={busy}
              disabled={code.length !== 6}
            />
            <Button
              label={t('auth.code.resend')}
              variant="secondary"
              busy={sending}
              onPress={() => sendCode(true)}
            />
            <Button
              label={t('auth.code.back')}
              variant="secondary"
              onPress={() => {
                setStep('password');
                setCode('');
                setInfo(undefined);
                setError(undefined);
              }}
            />
          </View>
        </>
      )}
    </Screen>
  );
}

function wrongCompany(t: TFunction): string {
  return t('auth.wrongCompany', { company: COMPANY?.name ?? '' });
}
