import { formatCalendarDate, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { keys, useOperations } from '../api.js';
import { buttonClass, cardClass, Dialog, Failure, Field, InlineError, inputClass } from '../ui.js';
import { useAssetAccess } from './asset-parts.js';

/**
 * Warranty alerts on web and desktop (CRM/ERP plan, phase E3; ADR-0008): the
 * company's warning window, and the dashboard's list of assets whose warranty
 * ends inside it. There is no email; the phone raises its own notification.
 */

const SHOWN = 8;

/** The assets whose warranty ends within the company's window, soonest first. */
export function WarrantyAlertsPanel() {
  const { t } = useTranslation();
  const { client, navigate, paths, locale } = useOperations();
  const access = useAssetAccess();
  const query = { warranty: 'expiring' as const, limit: 50 };
  const assets = useQuery({
    queryKey: keys.assets(query),
    queryFn: async () => (await client.GET('/v1/assets', { params: { query } })).data!,
    enabled: access.read,
  });
  const settings = useQuery({
    queryKey: keys.assetSettings,
    queryFn: async () => (await client.GET('/v1/assets/settings')).data!,
    enabled: access.read,
  });

  if (!access.read || assets.isPending) {
    return null;
  }
  const seeAll = `${paths.assets}?warranty=expiring`;
  const items = assets.isError
    ? []
    : [...assets.data.items].sort((a, b) =>
        (a.warrantyExpiresOn ?? '').localeCompare(b.warrantyExpiresOn ?? ''),
      );
  const more = assets.isError ? false : items.length > SHOWN || assets.data.nextCursor !== null;

  return (
    <section
      aria-labelledby="warranty-alerts-heading"
      className={`${cardClass} flex flex-col gap-3`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="warranty-alerts-heading" className="text-lg font-semibold text-content">
          {t('assets.alerts.title')}
        </h2>
        <a
          href={seeAll}
          className="text-sm text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(seeAll);
          }}
        >
          {t('assets.alerts.seeAll')}
        </a>
      </div>
      {settings.data === undefined ? null : (
        <p className="text-sm text-content-muted">
          {t('assets.alerts.window', { count: settings.data.warrantyAlertDays })}
        </p>
      )}
      {assets.isError ? (
        <InlineError onRetry={() => void assets.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-content-muted">{t('assets.alerts.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {items.slice(0, SHOWN).map((asset) => (
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
              <span className="text-content-muted">
                <span dir="auto">{asset.site.name}</span>
                {' · '}
                {t('assets.alerts.endsOn', {
                  date: formatCalendarDate(asset.warrantyExpiresOn ?? '', { locale }),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more ? <p className="text-sm text-content-muted">{t('assets.alerts.more')}</p> : null}
    </section>
  );
}

/** How far ahead warranties are flagged, for those who manage assets. */
export function AssetSettingsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const settings = useQuery({
    queryKey: keys.assetSettings,
    queryFn: async () => (await client.GET('/v1/assets/settings')).data!,
  });
  const [days, setDays] = useState<string | null>(null);
  const value =
    days ?? (settings.data === undefined ? '' : String(settings.data.warrantyAlertDays));
  const parsed = /^\d{1,3}$/u.test(value.trim()) ? Number(value.trim()) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 365;
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/assets/settings', {
          body: { expectedVersion: settings.data?.version ?? 0, warrantyAlertDays: parsed },
        })
      ).data!,
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey: ['assets'] });
      onClose();
    },
  });

  return (
    <Dialog
      title={t('assets.settings.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('assets.cancel')}
          </button>
          <button
            type="submit"
            form="asset-settings"
            className={buttonClass.primary}
            disabled={settings.data === undefined || !valid || save.isPending}
          >
            {save.isPending ? t('assets.saving') : t('assets.save')}
          </button>
        </>
      }
    >
      {settings.isError ? (
        <InlineError onRetry={() => void settings.refetch()} />
      ) : (
        <form
          id="asset-settings"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              save.mutate();
            }
          }}
        >
          <Field label={t('assets.settings.alertDays')} hint={t('assets.settings.alertDaysHint')}>
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                inputMode="numeric"
                className={inputClass}
                value={value}
                aria-invalid={value !== '' && !valid}
                onChange={(event) => setDays(event.target.value)}
              />
            )}
          </Field>
        </form>
      )}
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}
