import { createI18n, I18nextProvider, type Locale } from '@integr8/i18n';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { AppFrame } from '~/components/app-frame';
import { CompanyBrand } from '~/components/company-brand';
import { ShellChromeProvider } from '~/components/shell-chrome';
import { LoadingState } from '~/components/ui';
import {
  applyPreferences,
  readPreferences,
  writePreferences,
  type Preferences,
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
import { BrandingRoute } from '~/routes/branding';
import { DashboardRoute } from '~/routes/dashboard';
import { SignInRoute } from '~/routes/sign-in';

/**
 * The desktop app.
 *
 * A hash router rather than a browser router: the Tauri window loads the bundle
 * from a custom protocol where path-based routing needs the shell to cooperate,
 * and a hash route behaves identically in both homes. Keeping the two identical
 * is P05's second exit criterion, and this is the cheapest way to hold it.
 *
 * Every signed-in route is a child of one `RequireSession` layout route, which
 * puts the dashboard frame — side menu, top bar, impersonation banner — around
 * the screen and keeps it mounted from one screen to the next, so moving
 * between sections redraws the screen and not the menu. The sign-in screen
 * stands alone.
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

/** The signed-in screens, each the element of a route. */
const SIGNED_IN_ROUTES: readonly { path: string; element: ReactNode }[] = [
  { path: '/dashboard', element: <DashboardRoute /> },
  { path: '/forms', element: <FormsListRoute /> },
  { path: '/forms/:formId', element: <FormBuilderRoute /> },
  { path: '/forms/:formId/versions/:versionId', element: <FormVersionRoute /> },
  { path: '/fill', element: <FillRoute /> },
  { path: '/submissions', element: <SubmissionsRoute /> },
  { path: '/submissions/:submissionId', element: <SubmissionRoute /> },
  { path: '/work-orders', element: <WorkOrdersRoute /> },
  { path: '/work-orders/new', element: <NewWorkOrderRoute /> },
  { path: '/work-orders/:workOrderId', element: <WorkOrderRoute /> },
  { path: '/customers', element: <CustomersRoute /> },
  { path: '/customers/:customerId', element: <CustomerRoute /> },
  { path: '/sites/:siteId', element: <SiteRoute /> },
  { path: '/settings/job-types', element: <JobTypesRoute /> },
  { path: '/settings/branding', element: <BrandingRoute /> },
  { path: '/imports', element: <ImportsRoute /> },
  { path: '/timesheets', element: <TimesheetsRoute /> },
];

export function App() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());
  const [i18n, setI18n] = useState(() => createI18n({ locale: preferences.locale }));

  const changeLocale = useCallback((locale: Locale) => {
    setPreferences((current) => {
      const merged = { ...current, locale };
      writePreferences({ locale });
      applyPreferences(merged);
      return merged;
    });
    setI18n(createI18n({ locale }));
  }, []);

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <Routes>
            <Route path="/sign-in" element={<SignInRoute />} />
            <Route
              element={<RequireSession locale={preferences.locale} onLocaleChange={changeLocale} />}
            >
              {SIGNED_IN_ROUTES.map(({ path, element }) => (
                <Route key={path} path={path} element={element} />
              ))}
            </Route>
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </HashRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

/**
 * Redirects to sign-in when there is no usable session, and frames the screen
 * when there is one.
 *
 * "Usable" includes a device holding a live offline grant whose refresh token
 * has lapsed — an engineer a week into a job with no signal still has to get
 * in.
 */
function RequireSession({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const navigate = useNavigate();
  const queries = useQueryClient();
  const [state, setState] = useState<'checking' | 'allowed'>('checking');

  useEffect(() => {
    let cancelled = false;

    whenSignedOut(() => {
      // Whoever signs in next starts from nothing of this session's.
      queries.clear();
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
  }, [navigate, queries]);

  // The frame, the banner and the company's brand sit inside the guard, so
  // they are only ever asked for when there is a session to describe; the
  // brand's variables are lifted on sign-out.
  return state === 'checking' ? (
    <div className="flex h-dvh items-center justify-center">
      <LoadingState />
    </div>
  ) : (
    <ShellChromeProvider>
      <CompanyBrand />
      <AppFrame locale={locale} onLocaleChange={onLocaleChange}>
        <Outlet />
      </AppFrame>
    </ShellChromeProvider>
  );
}
