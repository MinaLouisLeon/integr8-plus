import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { keys, useOperations } from '../api.js';
import { DashboardBackLink, Loading } from '../ui.js';
import { EmployeeDetails, EmployeeStatusBadge, HrFailure, Notice } from './hr-parts.js';

/**
 * The signed-in person's own employee profile (ADR-0010): every member reads
 * theirs, ID and bank details included, and may show those in full. Nobody
 * changes it from here; that is HR's job, and somebody without a profile is
 * told to ask them.
 */
export function MyProfileScreen() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const profile = useQuery({
    queryKey: keys.myProfile,
    queryFn: async () => (await client.GET('/v1/hr/me')).data!,
  });

  const header = (
    <header className="flex flex-col gap-2">
      <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
        {t('hr.me.title')}
        {profile.data === undefined ? null : <EmployeeStatusBadge status={profile.data.status} />}
      </h1>
      <p className="text-sm text-content-muted">{t('hr.me.intro')}</p>
    </header>
  );

  if (profile.isPending) {
    return <Loading />;
  }
  if (profile.isError) {
    const none = profile.error instanceof ApiRequestError && profile.error.status === 404;
    return (
      <div className="flex flex-col gap-6 text-start">
        <DashboardBackLink />
        {header}
        {none ? (
          <Notice>
            <p>{t('hr.me.none')}</p>
          </Notice>
        ) : (
          <HrFailure error={profile.error} onRetry={() => void profile.refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      {header}
      <p className="text-lg font-medium text-content" dir="auto">
        {profile.data.fullName}
      </p>
      <EmployeeDetails employee={profile.data} />
    </div>
  );
}
