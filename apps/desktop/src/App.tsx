import {
  createI18n,
  I18nextProvider,
  LOCALE_DESCRIPTORS,
  useTranslation,
  type Locale,
} from '@integr8/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router';
import { LoadingState } from '~/components/ui';
import {
  applyPreferences,
  readPreferences,
  writePreferences,
  type Preferences,
  type ThemePreference,
} from '~/lib/preferences';
import { session, whenSignedOut } from '~/lib/session';
import { FormBuilderRoute } from '~/features/forms/routes/form-builder';
import { FormVersionRoute } from '~/features/forms/routes/form-version';
import { FormsListRoute } from '~/features/forms/routes/forms-list';
import {
  CustomerRoute,
  CustomersRoute,
  ImportsRoute,
  JobTypesRoute,
  NewWorkOrderRoute,
  SiteRoute,
  TimesheetsRoute,
  WorkOrderRoute,
  WorkOrdersRoute,
} from '~/features/operations/screens';
import { FillRoute, SubmissionRoute, SubmissionsRoute } from '~/features/submissions/screens';
import { DashboardRoute } from '~/routes/dashboard';
import { SignInRoute } from '~/routes/sign-in';

/**
 * The desktop shell.
 *
 * A hash router rather than a browser router: the Tauri window loads the bundle
 * from a custom protocol where path-based routing needs the shell to cooperate,
 * and a hash route behaves identically in both homes. Keeping the two identical
 * is P05's second exit criterion, and this is the cheapest way to hold it.
 */

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status;
        if (status !== undefined && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [i18n, setI18n] = useState(() => createI18n({ locale: preferences.locale }));

  const update = useCallback((next: Partial<Preferences>) => {
    setPreferences((current) => {
      const merged = { ...current, ...next };
      writePreferences(next);
      applyPreferences(merged);
      return merged;
    });

    if (next.locale !== undefined) {
      setI18n(createI18n({ locale: next.locale }));
    }
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          {/* The builder fills the window, so the page itself never scrolls; each screen scrolls its own content. */}
          <div className="flex h-dvh flex-col">
            <PreferenceBar preferences={preferences} onChange={update} />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <Routes>
                <Route path="/sign-in" element={<SignInRoute />} />
                <Route
                  path="/dashboard"
                  element={
                    <RequireSession>
                      <DashboardRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/forms"
                  element={
                    <RequireSession>
                      <FormsListRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/forms/:formId"
                  element={
                    <RequireSession>
                      <FormBuilderRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/forms/:formId/versions/:versionId"
                  element={
                    <RequireSession>
                      <FormVersionRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/fill"
                  element={
                    <RequireSession>
                      <FillRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/submissions"
                  element={
                    <RequireSession>
                      <SubmissionsRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/submissions/:submissionId"
                  element={
                    <RequireSession>
                      <SubmissionRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/work-orders"
                  element={
                    <RequireSession>
                      <WorkOrdersRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/work-orders/new"
                  element={
                    <RequireSession>
                      <NewWorkOrderRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/work-orders/:workOrderId"
                  element={
                    <RequireSession>
                      <WorkOrderRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/customers"
                  element={
                    <RequireSession>
                      <CustomersRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/customers/:customerId"
                  element={
                    <RequireSession>
                      <CustomerRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/sites/:siteId"
                  element={
                    <RequireSession>
                      <SiteRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/settings/job-types"
                  element={
                    <RequireSession>
                      <JobTypesRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/imports"
                  element={
                    <RequireSession>
                      <ImportsRoute />
                    </RequireSession>
                  }
                />
                <Route
                  path="/timesheets"
                  element={
                    <RequireSession>
                      <TimesheetsRoute />
                    </RequireSession>
                  }
                />
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </div>
          </div>
        </HashRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

/**
 * Redirects to sign-in when there is no usable session.
 *
 * "Usable" includes a device holding a live offline grant whose refresh token
 * has lapsed — an engineer a week into a job with no signal still has to get
 * in.
 */
function RequireSession({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<'checking' | 'allowed'>('checking');

  useEffect(() => {
    let cancelled = false;

    whenSignedOut(() => {
      void navigate('/sign-in', { replace: true });
    });

    void (async () => {
      const allowed = await session().isSignedIn();
      if (cancelled) {
        return;
      }

      if (allowed) {
        setState('allowed');
      } else {
        void navigate('/sign-in', { replace: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return state === 'checking' ? <LoadingState /> : <>{children}</>;
}

function PreferenceBar({
  preferences,
  onChange,
}: {
  preferences: Preferences;
  onChange: (next: Partial<Preferences>) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-4 border-b border-border-subtle px-6 py-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-content-muted">{t('common.language')}</span>
        <select
          value={preferences.locale}
          onChange={(event) => {
            onChange({ locale: event.target.value as Locale });
          }}
          className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
        >
          {LOCALE_DESCRIPTORS.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.nativeName}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-content-muted">{t('common.theme.label')}</span>
        <select
          value={preferences.theme}
          onChange={(event) => {
            onChange({ theme: event.target.value as ThemePreference });
          }}
          className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-content"
        >
          <option value="system">{t('common.theme.system')}</option>
          <option value="light">{t('common.theme.light')}</option>
          <option value="dark">{t('common.theme.dark')}</option>
        </select>
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={preferences.forceRtl}
          onChange={(event) => {
            onChange({ forceRtl: event.target.checked });
          }}
        />
        <span className="text-content-muted">{t('common.forceRtl')}</span>
      </label>
    </div>
  );
}
