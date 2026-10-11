import { ApiRequestError } from '@integr8/api-client';
import { tagCodeOf } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useOperations } from '../api.js';
import { BackLink, Failure, Loading } from '../ui.js';

/**
 * What a scanned tag link opens (CRM/ERP plan, phase E3; ADR-0008): the
 * asset, for a signed-in seat of its company. A code of another company, an
 * old tag and a mistyped code all read the same: no asset has this tag.
 */
export function AssetTagOpener({ code }: { code: string }) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const normalized = tagCodeOf(code);
  const found = useQuery({
    queryKey: ['assets', 'tag', normalized ?? ''],
    queryFn: async () =>
      (
        await client.GET('/v1/assets/by-tag/{code}', {
          params: { path: { code: normalized! } },
        })
      ).data!,
    enabled: normalized !== undefined,
    retry: false,
  });
  useEffect(() => {
    if (found.data !== undefined) {
      navigate(paths.asset(found.data.id), { replace: true });
    }
  }, [found.data, navigate, paths]);

  const missing =
    normalized === undefined ||
    (found.error instanceof ApiRequestError && found.error.status === 404);
  if (!missing && (found.isPending || found.data !== undefined)) {
    return <Loading />;
  }
  return (
    <div className="flex flex-col gap-4 text-start">
      <BackLink to={paths.assets} label={t('assets.back')} />
      {missing ? (
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold text-content">{t('assets.tags.unknownTitle')}</h1>
          <p className="text-sm text-content-muted">{t('assets.tags.unknown')}</p>
        </div>
      ) : (
        <Failure error={found.error} onRetry={() => void found.refetch()} />
      )}
    </div>
  );
}
