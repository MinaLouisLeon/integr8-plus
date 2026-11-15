import { ApiRequestError } from '@integr8/api-client';
import { apiErrorMessage, type TFunction, useTranslation } from '@integr8/i18n';
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { integr8Fonts } from '@integr8/tokens';
import { useNavigate } from 'react-router';
import { useResolvedTheme } from '~/components/company-brand';
import { LegalLinks } from '~/components/legal-links';
import { Button, Field, LoadingState, Shell } from '~/components/ui';
import {
  applyBrandVariables,
  applyTheme,
  brandVariables,
  readRememberedBrand,
  type RememberedBrand,
} from '~/lib/company-theme';
import { API_BASE_URL, APP_FLAVOR, COMPANY_SLUG } from '~/lib/env';
import { integr8Look } from '~/lib/look';
import { session } from '~/lib/session';

/**
 * Integr8 staff's sign-in, with the staff dashboard behind it (P42). Loaded
 * only when the build is not a company's: Vite inlines the flavour, so in a
 * company build this is `null` and the module is left out of the bundle.
 */
const StaffSignIn =
  import.meta.env.VITE_APP_FLAVOR === 'company'
    ? null
    : lazy(() => import('~/features/platform/staff-sign-in'));

/**
 * Two doors into the same app.
 *
 * A company's people sign in with the address their company invited. Integr8
 * staff sign in with their platform account and then choose the company they
 * are setting up, because forms and job types are built by Integr8 rather than
 * by the company, and staff must be able to do that without becoming members
 * or knowing anybody's password. See `~/lib/staff`.
 *
 * From the second launch on, the screen already looks like the company's: the
 * last session left the company's name, logo and colours in storage (see
 * `~/lib/company-theme`), and they are worn here before anybody signs in.
 *
 * Which doors are open depends on the build (`APP_FLAVOR`): Integr8's own
 * staff build shows only the staff door, a company's build only the company
 * door — pinned to that company, so the API refuses anybody from another —
 * and a development build both, as tabs.
 */
export function SignInRoute() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'company' | 'staff'>('company');
  const brand = useRememberedBrand();

  return (
    // The staff build signs in on Integr8's own look (Low 3); a company's build on its brand.
    <div {...integr8Look()} className="min-h-dvh">
      <Shell>
        <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-8">
          {APP_FLAVOR === 'staff' ? <Integr8Mark /> : null}
          {brand === undefined ? null : <RememberedBrandMark brand={brand} />}

          {APP_FLAVOR === 'staff' ? (
            <StaffDoor />
          ) : APP_FLAVOR === 'company' ? (
            <CompanySignIn companyName={brand?.name ?? COMPANY_SLUG ?? ''} />
          ) : (
            <>
              <div role="tablist" aria-label={t('auth.signInTitle')} className="flex gap-1">
                <ModeTab selected={mode === 'company'} onSelect={() => setMode('company')}>
                  {t('auth.staff.companyTab')}
                </ModeTab>
                <ModeTab selected={mode === 'staff'} onSelect={() => setMode('staff')}>
                  {t('auth.staff.tab')}
                </ModeTab>
              </div>

              {mode === 'company' ? (
                <CompanySignIn companyName={brand?.name ?? ''} />
              ) : (
                <StaffDoor />
              )}
            </>
          )}

          <LegalLinks />
        </div>
      </Shell>
    </div>
  );
}

/** The staff sign-in, while its module loads; nothing at all in a company's build. */
function StaffDoor() {
  return StaffSignIn === null ? null : (
    <Suspense fallback={<LoadingState />}>
      <StaffSignIn />
    </Suspense>
  );
}

/** Integr8's mark above the staff sign-in: "Integr", a lime "8", and "PLUS". */
function Integr8Mark() {
  return (
    <p
      dir="ltr"
      className="flex items-center self-start text-2xl font-extrabold text-content"
      style={{ fontFamily: integr8Fonts.display }}
    >
      Integr<span className="text-lime">8</span>
      <span
        className="ms-2 text-xs font-medium tracking-[0.3em] text-content-muted"
        style={{ fontFamily: integr8Fonts.body }}
      >
        PLUS
      </span>
    </p>
  );
}

/**
 * The brand the last session left behind, worn while this screen is on show.
 * The variables are lifted when it goes, so a different company signing in
 * does not inherit the previous one's colours for a frame.
 */
function useRememberedBrand(): RememberedBrand | undefined {
  const [brand] = useState(() => {
    // Integr8's own build wears no company's brand; a company's build wears
    // only its own, never one left behind by a different company's session.
    if (APP_FLAVOR === 'staff') {
      return undefined;
    }
    const remembered = readRememberedBrand();
    if (
      remembered !== undefined &&
      COMPANY_SLUG !== undefined &&
      remembered.slug !== COMPANY_SLUG
    ) {
      return undefined;
    }
    return remembered;
  });
  const theme = useResolvedTheme();

  useEffect(() => {
    if (brand !== undefined) {
      applyTheme(brand.defaultTheme);
    }
  }, [brand]);

  useEffect(() => {
    if (brand === undefined) {
      return;
    }
    return applyBrandVariables(brandVariables(brand.brandColour, brand.shellColour, theme));
  }, [brand, theme]);

  return brand;
}

/** The company's name and logo above the form. The logo is the public route; the browser follows its redirect. */
function RememberedBrandMark({ brand }: { brand: RememberedBrand }) {
  // The logo stands alone when Integr8 switched the name off (0075).
  const logoOnly = brand.logoPath !== undefined && brand.showName === false;
  return (
    <div className="flex items-center gap-3 text-start">
      {brand.logoPath === undefined ? null : (
        // Decorative beside the name, which carries the meaning, unless it stands alone.
        <img
          src={`${API_BASE_URL}${brand.logoPath}`}
          alt={logoOnly ? brand.name : ''}
          className="h-12 w-auto max-w-40 object-contain"
        />
      )}
      {logoOnly ? null : <span className="text-xl font-semibold text-content">{brand.name}</span>}
    </div>
  );
}

function ModeTab({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`rounded-md px-3 py-1.5 text-sm ${
        selected
          ? 'bg-accent text-on-accent'
          : 'text-content-muted hover:bg-surface-muted hover:text-content'
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// A company's own person
// ---------------------------------------------------------------------------

function CompanySignIn({ companyName }: { companyName: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The way back in for somebody who has forgotten their password (P36): a
  // 6-digit code by email, entered on a second step.
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [requesting, setRequesting] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await session().signInWithPassword({
          email,
          password,
          deviceLabel: 'Desktop',
          ...(COMPANY_SLUG === undefined ? {} : { companySlug: COMPANY_SLUG }),
        });
        void navigate('/dashboard', { replace: true });
      } catch (failure) {
        setError(messageFor(failure, t, companyName));
      } finally {
        setBusy(false);
      }
    })();
  };

  const requestCode = () => {
    if (email.trim() === '') {
      setError(t('auth.code.needEmail'));
      return;
    }
    setRequesting(true);
    setError(undefined);

    void (async () => {
      try {
        await session().requestSignInCode(email.trim(), uiLocale(i18n.language));
        setStep('code');
      } catch (failure) {
        setError(codeRequestMessage(failure, t));
      } finally {
        setRequesting(false);
      }
    })();
  };

  if (step === 'code') {
    return (
      <CodeSignIn
        email={email.trim()}
        companyName={companyName}
        onBack={() => {
          setStep('password');
          setError(undefined);
        }}
      />
    );
  }

  return (
    <>
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
        <Button type="button" variant="ghost" busy={requesting} onClick={requestCode}>
          {t('auth.code.request')}
        </Button>
      </form>
    </>
  );
}

/**
 * The code step (P36). Every failure to complete gets one message, so the
 * screen never says whether the address has an account; a lock and a
 * company's own build refusing an outsider are the exceptions, as on the
 * password step.
 */
export function CodeSignIn({
  email,
  companyName,
  onBack,
}: {
  email: string;
  companyName: string;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string>(() => t('auth.code.sent', { email }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await session().signInWithCode({
          email,
          code: code.trim(),
          deviceLabel: 'Desktop',
          ...(COMPANY_SLUG === undefined ? {} : { companySlug: COMPANY_SLUG }),
        });
        void navigate('/dashboard', { replace: true });
      } catch (failure) {
        setError(codeFailureMessage(failure, t, companyName));
      } finally {
        setBusy(false);
      }
    })();
  };

  const resend = () => {
    setResending(true);
    setError(undefined);

    void (async () => {
      try {
        await session().requestSignInCode(email, uiLocale(i18n.language));
        setNotice(t('auth.code.resent'));
      } catch (failure) {
        setError(codeRequestMessage(failure, t));
      } finally {
        setResending(false);
      }
    })();
  };

  return (
    <>
      <div className="flex flex-col gap-1 text-start">
        <h1 className="text-2xl font-semibold text-content">{t('auth.code.title')}</h1>
        <p role="status" className="text-sm text-content-muted">
          {notice}
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label={t('auth.code.label')}
          placeholder={t('auth.code.hint')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/gu, ''))}
          {...(error === undefined ? {} : { error })}
        />
        <Button type="submit" busy={busy} disabled={code.length !== 6}>
          {busy ? t('auth.signingIn') : t('auth.code.submit')}
        </Button>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" busy={resending} onClick={resend}>
            {t('auth.code.resend')}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t('auth.code.back')}
          </Button>
        </div>
      </form>
    </>
  );
}

/** The language an email should be in: the one this screen is showing. */
export function uiLocale(language: string): 'en' | 'ar' {
  return language.startsWith('ar') ? 'ar' : 'en';
}

/** Asking for a code fails only for a limit or an outage; otherwise the answer is the same for everyone. */
function codeRequestMessage(failure: unknown, t: TFunction): string {
  if (failure instanceof ApiRequestError && failure.status === 429) {
    return t('auth.code.wait');
  }
  return messageFor(failure, t);
}

export function codeFailureMessage(failure: unknown, t: TFunction, companyName: string): string {
  if (failure instanceof ApiRequestError) {
    if (failure.code === 'wrong_company' || failure.code === 'auth.wrong_company') {
      return t('auth.wrongCompany', { company: companyName });
    }
    if (failure.status === 423) {
      return t('auth.accountLocked');
    }
    if (failure.status === 429) {
      return t('auth.code.wait');
    }
    return t('auth.code.failed');
  }
  return messageFor(failure, t);
}

/** The server's message is for a log; this is the one a person reads. */
function messageFor(failure: unknown, t: TFunction, companyName = ''): string {
  if (!(failure instanceof ApiRequestError)) {
    // No response at all: the API is unreachable, or the window was not
    // allowed to call it. Either way, not a wrong password.
    return failure instanceof TypeError ? t('errors.offline') : t('errors.unexpected');
  }

  switch (failure.code) {
    // A company's build signs in to that company only; an account elsewhere
    // is told so, rather than that its password is wrong.
    case 'wrong_company':
    case 'auth.wrong_company':
      return t('auth.wrongCompany', { company: companyName });
    default:
      // The platform sign-in answers a wrong email, password or code with a
      // plain 401, and says no more on purpose.
      if (failure.status === 401) {
        return t('auth.invalidCredentials');
      }
      // Everything else in the catalogue's words for its code (ADR-0012).
      return apiErrorMessage(failure, t);
  }
}
