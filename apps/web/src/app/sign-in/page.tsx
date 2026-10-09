'use client';

import { useTranslation } from '@integr8/i18n';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useBrandAccent, useBrandTheme } from '~/components/company-brand';
import { Button, Field } from '~/components/ui';
import {
  parseBrand,
  rememberedBrandSnapshot,
  subscribeToRememberedBrand,
} from '~/lib/brand-memory';
import { messageForError } from '~/lib/errors';
import { signIn } from '~/lib/session';

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
 */
export default function SignInPage() {
  const { t } = useTranslation();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
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
        router.push('/dashboard');
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
    </main>
  );
}
