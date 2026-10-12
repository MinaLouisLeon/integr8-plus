import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type AssetRow, keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Failure, Field, InlineError, inputClass } from '../ui.js';
import {
  AssetStatusBadge,
  ConditionBadge,
  NewAssetDialog,
  useAssetAccess,
  WarrantyBadge,
} from './asset-parts.js';
import { ConditionDialog } from './asset-screen.js';

/**
 * The assets a job is for, on the job screen (CRM/ERP plan, phase E3):
 * linking one of the site's assets, registering one found on site, and
 * recording its condition on this job. Shown only with the assets module.
 */
export function JobAssetsPanel({ workOrderId }: { workOrderId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const queries = useQueryClient();
  const access = useAssetAccess();
  const [choice, setChoice] = useState('');
  const [registering, setRegistering] = useState(false);
  const [recording, setRecording] = useState<string | null>(null);

  const assets = useQuery({
    queryKey: keys.jobAssets(workOrderId),
    queryFn: async () =>
      (
        await client.GET('/v1/work-orders/{workOrderId}/assets', {
          params: { path: { workOrderId } },
        })
      ).data!,
    enabled: access.read,
  });
  const refresh = () => queries.invalidateQueries({ queryKey: ['assets'] });
  const link = useMutation({
    mutationFn: async (assetId: string) =>
      client.POST('/v1/work-orders/{workOrderId}/assets', {
        params: { path: { workOrderId } },
        body: { assetId },
      }),
    onSuccess: async () => {
      setChoice('');
      await refresh();
    },
  });
  const unlink = useMutation({
    mutationFn: async (assetId: string) =>
      client.DELETE('/v1/work-orders/{workOrderId}/assets/{assetId}', {
        params: { path: { workOrderId, assetId } },
      }),
    onSuccess: refresh,
  });

  if (!access.read) {
    return null;
  }
  const row = (asset: AssetRow) => (
    <li key={asset.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <a
          href={paths.asset(asset.id)}
          className="text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.asset(asset.id));
          }}
        >
          <span dir="ltr">{asset.reference}</span> · <span dir="auto">{asset.name}</span>
        </a>
        <AssetStatusBadge status={asset.status} />
        <ConditionBadge condition={asset.condition} />
        <WarrantyBadge warranty={asset.warranty} />
      </span>
      <span className="flex gap-2">
        {assets.data?.can.register === true && asset.status !== 'retired' ? (
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => setRecording(asset.id)}
          >
            {t('assets.recordCondition')}
          </button>
        ) : null}
        {assets.data?.can.unlink === true ? (
          <button
            type="button"
            className={buttonClass.ghost}
            disabled={unlink.isPending}
            onClick={() => {
              if (window.confirm(t('assets.unlinkConfirm'))) {
                unlink.mutate(asset.id);
              }
            }}
          >
            {t('assets.unlink')}
          </button>
        ) : null}
      </span>
    </li>
  );

  return (
    <section aria-labelledby="job-assets-heading" className={`${cardClass} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="job-assets-heading" className="text-lg font-semibold text-content">
          {t('assets.onThisJob')}
        </h2>
        {assets.data?.can.register === true ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setRegistering(true)}>
            {t('assets.registerHere')}
          </button>
        ) : null}
      </div>
      {assets.isPending ? null : assets.isError ? (
        <InlineError onRetry={() => void assets.refetch()} />
      ) : (
        <>
          {assets.data.items.length === 0 ? (
            <p className="text-sm text-content-muted">{t('assets.noneOnJob')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {assets.data.items.map(row)}
            </ul>
          )}
          {assets.data.can.link && assets.data.atSite.length > 0 ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (choice !== '') {
                  link.mutate(choice);
                }
              }}
            >
              <Field label={t('assets.linkFromSite')} className="min-w-64 flex-1">
                {(id) => (
                  <select
                    id={id}
                    className={inputClass}
                    value={choice}
                    onChange={(event) => setChoice(event.target.value)}
                  >
                    <option value="">{t('assets.chooseAsset')}</option>
                    {assets.data.atSite.map((asset) => (
                      <option key={asset.id} value={asset.id}>
                        {`${asset.reference} · ${asset.name}`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <button
                type="submit"
                className={buttonClass.secondary}
                disabled={choice === '' || link.isPending}
              >
                {t('assets.link')}
              </button>
            </form>
          ) : null}
        </>
      )}
      {link.isError ? <Failure error={link.error} /> : null}
      {unlink.isError ? <Failure error={unlink.error} /> : null}
      {registering ? (
        <NewAssetDialog
          workOrderId={workOrderId}
          onClose={() => setRegistering(false)}
          onDone={() => {
            setRegistering(false);
            void refresh();
          }}
        />
      ) : null}
      {recording === null ? null : (
        <ConditionDialog
          assetId={recording}
          workOrderId={workOrderId}
          onClose={() => setRecording(null)}
          onDone={refresh}
        />
      )}
    </section>
  );
}

/** A site's assets, on the site screen, with registering one there. */
export function SiteAssetsSection({
  site,
}: {
  site: { id: string; name: string; customer: { id: string; name: string } };
}) {
  const { t } = useTranslation();
  const { client, paths, navigate } = useOperations();
  const access = useAssetAccess();
  const [registering, setRegistering] = useState(false);
  const query = { siteId: site.id, limit: 200 };
  const assets = useQuery({
    queryKey: keys.assets(query),
    queryFn: async () => (await client.GET('/v1/assets', { params: { query } })).data!,
    enabled: access.read,
  });
  if (!access.read) {
    return null;
  }
  return (
    <section aria-labelledby="site-assets-heading" className={`${cardClass} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="site-assets-heading" className="text-lg font-semibold text-content">
          {t('assets.title')}
        </h2>
        {access.manage ? (
          <button type="button" className={buttonClass.ghost} onClick={() => setRegistering(true)}>
            {t('assets.new')}
          </button>
        ) : null}
      </div>
      {assets.isPending ? null : assets.isError ? (
        <InlineError onRetry={() => void assets.refetch()} />
      ) : assets.data.items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('assets.noneAtSite')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {assets.data.items.map((asset) => (
            <li key={asset.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <a
                href={paths.asset(asset.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.asset(asset.id));
                }}
              >
                <span dir="ltr">{asset.reference}</span> · <span dir="auto">{asset.name}</span>
              </a>
              <span className="flex flex-wrap items-center gap-2">
                <AssetStatusBadge status={asset.status} />
                <WarrantyBadge warranty={asset.warranty} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {registering ? <NewAssetDialog site={site} onClose={() => setRegistering(false)} /> : null}
    </section>
  );
}
