'use client';

import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useBrandAccent, useBrandTheme } from '~/components/company-brand';
import { LegalLinks } from '~/components/legal-links';
import { Button, Field } from '~/components/ui';
import {
  parseBrand,
  rememberedBrandSnapshot,
  subscribeToRememberedBrand,
} from '~/lib/brand-memory';
import { messageForError } from '~/lib/errors';
import { safeReturnPath } from '~/lib/return-path';
import { requestSignInCode, signIn, signInWithCode } from '~/lib/session';

/**
 * Sign in.
 *
 * Every string comes from the translation layer, including the failure
 * messages. The API's messages are not shown directly: they are written for a
 * developer reading a log, and a person needs the one their own app author
 * chose.
 *
 * From the second visit the page wears the company's look. Nobody is signed in
 * yet, so it cannot ask who they are; it shows what the last signed-in session
 * remembered — name, public logo, colours, theme — which is what the company's
 * website shows anybody. Read as an external store whose server snapshot is
 * empty, so the server and the hydrating render agree.
 *
 * Somebody who has forgotten their password signs in with an emailed 6-digit
 * code instead (P36). Every way that can fail gets the same words, so the page
 * never says whether an address has an account.
 */
export default function SignInPage() {
  const { t, i18n } = useTranslation();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'password' | 'code'>('password');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const language = i18n.resolvedLanguage ?? i18n.language;
  const locale = language === 'ar' ? 'ar' : 'en';

  const goOn = () => {
    const next = safeReturnPath(new URLSearchParams(window.location.search).get('next'));
    router.push(next ?? '/dashboard');
  };

  const askForCode = (again: boolean) => {
    if (email.trim() === '') {
      setError(t('auth.code.needEmail'));
      return;
    }
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await requestSignInCode(email.trim(), locale);
        setMode('code');
        setCode('');
        setNotice(again ? t('auth.code.resent') : t('auth.code.sent', { email: email.trim() }));
      } catch (failure) {
        setError(
          failure instanceof ApiRequestError && failure.status === 429
            ? t('auth.code.wait')
            : messageForError(failure, t),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        await signInWithCode(email.trim(), code.trim());
        goOn();
      } catch (failure) {
        // One message for a wrong, spent or expired code; a lock says so.
        setError(
          failure instanceof ApiRequestError && failure.status === 423
            ? t('auth.accountLocked')
            : t('auth.code.failed'),
        );
      } finally {
        setBusy(false);
      }
    })();
  };
  const [logoBroken, setLogoBroken] = useState(false);

  const rememberedText = useSyncExternalStore(
    subscribeToRememberedBrand,
    rememberedBrandSnapshot,
    () => null,
  );
  const brand = useMemo(() => parseBrand(rememberedText), [rememberedText]);
  useBrandAccent(brand?.brandColour ?? null);
  useBrandTheme(brand?.defaultTheme ?? null, false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await signIn(email, password);
        goOn();
      } catch (failure) {
        setError(messageForError(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-6">
      {brand === null ? null : (
        <div className="flex items-center gap-3">
          {brand.logoUrl === null || logoBroken ? null : (
            // The public logo link: the API redirects to a fresh signed one.
            // A company that has since removed its logo returns 404, and the
            // image hides rather than showing a broken picture.
            <img
              src={brand.logoUrl}
              alt=""
              className="h-10 w-auto max-w-40 object-contain"
              onError={() => setLogoBroken(true)}
            />
          )}
          <span className="text-lg font-semibold text-content">{brand.name}</span>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">
          {brand === null ? t('auth.signInTitle') : t('auth.signInTo', { company: brand.name })}
        </h1>
        <p className="text-sm text-content-muted">{t('auth.signInSubtitle')}</p>
      </div>

      {mode === 'password' ? (
        <>
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
          <Button variant="ghost" disabled={busy} onClick={() => askForCode(false)}>
            {t('auth.code.request')}
          </Button>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-content">{t('auth.code.title')}</h2>
            {notice === undefined ? null : (
              <p role="status" className="text-sm text-content-muted">
                {notice}
              </p>
            )}
          </div>
          <form onSubmit={submitCode} className="flex flex-col gap-4" noValidate>
            <Field
              label={t('auth.code.label')}
              hint={t('auth.code.hint')}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              dir="ltr"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
              {...(error === undefined ? {} : { error })}
            />
            <Button type="submit" busy={busy} disabled={code.trim().length !== 6}>
              {busy ? t('auth.signingIn') : t('auth.code.submit')}
            </Button>
          </form>
          <div className="flex flex-col gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => askForCode(true)}>
              {t('auth.code.resend')}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setMode('password');
                setError(undefined);
                setNotice(undefined);
              }}
            >
              {t('auth.code.back')}
            </Button>
          </div>
        </>
      )}

      {/* The privacy policy, one click from where an address and password are typed (High 10). */}
      <LegalLinks className="pt-2" />
    </main>
  );
}
