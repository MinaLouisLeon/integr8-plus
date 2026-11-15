import type { Locale } from '@integr8/i18n';
import { useSyncExternalStore } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { PlatformFrame } from './frame';
import { AnnouncementsRoute } from './screens/announcements';
import { AuditRoute } from './screens/audit';
import { CompaniesRoute } from './screens/companies';
import { CompanyRoute } from './screens/company';
import { DownloadsRoute } from './screens/downloads';
import { FlagsRoute } from './screens/flags';
import { HealthRoute } from './screens/health';
import { PlansRoute } from './screens/plans';
import { ReleasesRoute } from './screens/releases';
import { StaffRoute } from './screens/staff';
import { StorageRoute } from './screens/storage';
import { TemplatesRoute } from './screens/templates';
import { hasPlatformSession, onPlatformSessionChange } from './session';

/**
 * The staff dashboard, under `/platform` (P42).
 *
 * Loaded on its own, and only by the staff build and the development build:
 * `App.tsx` imports this module lazily behind the build's flavour, so a
 * company's installer carries none of it (`scripts/check-company-bundle.mjs`
 * checks the built bundle).
 *
 * Guarded by the platform session held in memory: without one, staff sign in
 * again. A refresh that fails ends the session, and the guard sees it.
 */
export default function PlatformApp({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const signedIn = useSyncExternalStore(onPlatformSessionChange, hasPlatformSession);
  if (!signedIn) {
    return <Navigate to="/sign-in" replace />;
  }

  return (
    <PlatformFrame locale={locale} onLocaleChange={onLocaleChange}>
      <Routes>
        <Route index element={<CompaniesRoute />} />
        <Route path="companies/:tenantId" element={<CompanyRoute />} />
        <Route path="storage" element={<StorageRoute />} />
        <Route path="plans" element={<PlansRoute />} />
        <Route path="audit" element={<AuditRoute />} />
        <Route path="flags" element={<FlagsRoute />} />
        <Route path="announcements" element={<AnnouncementsRoute />} />
        <Route path="templates" element={<TemplatesRoute />} />
        <Route path="releases" element={<ReleasesRoute />} />
        <Route path="health" element={<HealthRoute />} />
        <Route path="staff" element={<StaffRoute />} />
        <Route path="downloads" element={<DownloadsRoute />} />
        <Route path="*" element={<Navigate to="/platform" replace />} />
      </Routes>
    </PlatformFrame>
  );
}
