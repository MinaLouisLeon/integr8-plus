import { ApiRequestError } from '@integr8/api-client';
import { useTranslation, type TFunction } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useResolvedTheme } from '~/components/company-brand';
import { Button, EmptyState, ErrorState, Field, LoadingState, Shell } from '~/components/ui';
import {
  applyBrandVariables,
  applyTheme,
  brandVariables,
  readRememberedBrand,
  type RememberedBrand,
} from '~/lib/company-theme';
import { API_BASE_URL, APP_FLAVOR, COMPANY_SLUG } from '~/lib/env';
import { session } from '~/lib/session';
import {
  type CompanyChoice,
  forgetPlatformSession,
  listCompanies,
  openCompany,
  staffSignIn,
  type StaffUser,
} from '~/lib/staff';

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
    <Shell>
      <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-8">
        {brand === undefined ? null : <RememberedBrandMark brand={brand} />}

        {APP_FLAVOR === 'staff' ? (
          <StaffSignIn />
        ) : APP_FLAVOR === 'company' ? (
          <CompanySignIn companyName={brand?.name ?? COMPANY_SLUG ?? ''} />
        ) : (
          <>
            <div role="tablist" aria-label={t('auth.signInTitle')} className="flex gap-1">
              <ModeTab
                selected={mode === 'company'}
                onSelect={() => {
                  forgetPlatformSession();
                  setMode('company');
                }}
              >
                {t('auth.staff.companyTab')}
              </ModeTab>
              <ModeTab selected={mode === 'staff'} onSelect={() => setMode('staff')}>
                {t('auth.staff.tab')}
              </ModeTab>
            </div>

            {mode === 'company' ? (
              <CompanySignIn companyName={brand?.name ?? ''} />
            ) : (
              <StaffSignIn />
            )}
          </>
        )}
      </div>
    </Shell>
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
  return (
    <div className="flex items-center gap-3 text-start">
      {brand.logoPath === undefined ? null : (
        // Decorative beside the name, which carries the meaning.
        <img
          src={`${API_BASE_URL}${brand.logoPath}`}
          alt=""
          className="h-12 w-auto max-w-40 object-contain"
        />
      )}
      <span className="text-xl font-semibold text-content">{brand.name}</span>
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
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

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
      </form>
    </>
  );
}

// ---------------------------------------------------------------------------
// Integr8 staff
// ---------------------------------------------------------------------------

function StaffSignIn() {
  const { t } = useTranslation();
  const [staff, setStaff] = useState<StaffUser | undefined>(undefined);

  return (
    <>
      <div className="flex flex-col gap-1 text-start">
        <h1 className="text-2xl font-semibold text-content">{t('auth.staff.title')}</h1>
        <p className="text-sm text-content-muted">{t('auth.staff.subtitle')}</p>
      </div>

      {staff === undefined ? (
        <StaffCredentials onSignedIn={setStaff} />
      ) : (
        <CompanyPicker
          staff={staff}
          onBack={() => {
            forgetPlatformSession();
            setStaff(undefined);
          }}
        />
      )}
    </>
  );
}

function StaffCredentials({ onSignedIn }: { onSignedIn: (staff: StaffUser) => void }) {
  const { t } = useTranslation();
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
        onSignedIn(await staffSignIn({ email, password, code }));
      } catch (failure) {
        setError(messageFor(failure, t));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
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
  );
}

function CompanyPicker({ staff, onBack }: { staff: StaffUser; onBack: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<CompanyChoice | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const companies = useQuery({
    queryKey: ['staff', 'companies', search],
    queryFn: () => listCompanies(search),
  });

  const open = (event: FormEvent) => {
    event.preventDefault();
    if (chosen === undefined) {
      return;
    }
    setBusy(true);
    setError(undefined);

    void (async () => {
      try {
        await openCompany(chosen.id, reason);
        void navigate('/dashboard', { replace: true });
      } catch (failure) {
        setError(messageFor(failure, t));
        setBusy(false);
      }
    })();
  };

  return (
    <form onSubmit={open} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-content-muted">
        {t('workspace.signedInAs', { name: staff.displayName })}
      </p>

      <Field
        label={t('auth.staff.search')}
        type="search"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
          setChosen(undefined);
        }}
      />

      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium text-content">
          {t('auth.staff.chooseCompany')}
        </legend>
        {companies.isPending ? <LoadingState /> : null}
        {companies.isError ? (
          <ErrorState
            requestId={
              companies.error instanceof ApiRequestError ? companies.error.requestId : undefined
            }
            onRetry={() => void companies.refetch()}
          />
        ) : null}
        {companies.data?.length === 0 ? <EmptyState title={t('auth.staff.noCompanies')} /> : null}
        {companies.data?.map((company) => (
          <label
            key={company.id}
            aria-label={company.name}
            className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-start text-sm ${
              chosen?.id === company.id ? 'border-accent bg-surface-muted' : 'border-border-subtle'
            }`}
          >
            <input
              type="radio"
              name="company"
              value={company.id}
              checked={chosen?.id === company.id}
              onChange={() => setChosen(company)}
            />
            <span className="flex flex-1 flex-col">
              <span className="font-medium text-content">{company.name}</span>
              <span className="text-xs text-content-muted">
                {company.slug}
                {company.members === 0 ? ` · ${t('auth.staff.noOwnerYet')}` : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <Field
        label={t('auth.staff.reason')}
        placeholder={t('auth.staff.reasonHint')}
        required
        minLength={10}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        {...(error === undefined ? {} : { error })}
      />

      <div className="flex gap-2">
        <Button
          type="submit"
          busy={busy}
          disabled={chosen === undefined || reason.trim().length < 10}
        >
          {busy ? t('auth.staff.opening') : t('auth.staff.open')}
        </Button>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t('auth.staff.back')}
        </Button>
      </div>
    </form>
  );
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
      // The platform sign-in answers a wrong email, password or code with a
      // plain 401, and says no more on purpose.
      if (failure.status === 401) {
        return t('auth.invalidCredentials');
      }
      if (failure.status === 429) {
        return t('auth.rateLimited');
      }
      return t('errors.unexpected');
  }
}
