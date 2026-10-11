import { ASSET_CONDITIONS, hasFeature } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type AssetCondition,
  type AssetDetail,
  type AssetRow,
  type AssetStatus,
  keys,
  useOperations,
} from '../api.js';
import { CustomerPicker } from '../crm/opportunity-parts.js';
import { useIdempotencyKey } from '../purchasing/purchasing-parts.js';
import { buttonClass, Dialog, Failure, Field, inputClass } from '../ui.js';

/**
 * Pieces the asset screens share (CRM/ERP plan, phase E3; ADR-0008): who may
 * do what, the status, condition and warranty badges, choosing a site, and
 * registering an asset — from the register, a site, or a job.
 */

/** What this seat may do with the company's assets. */
export function useAssetAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions = me.data?.permissions ?? [];
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'assets');
  return {
    loaded: me.data !== undefined,
    enabled,
    read: enabled && permissions.includes('asset.read'),
    record: enabled && permissions.includes('asset.record'),
    manage: enabled && permissions.includes('asset.manage'),
  };
}

const badge = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

const STATUS_STYLE: Record<AssetStatus, string> = {
  active: 'border-success text-content',
  out_of_service: 'border-warning bg-warning-subtle text-content',
  retired: 'border-border-subtle bg-surface-muted text-content-muted line-through',
};

export function AssetStatusBadge({ status }: { status: AssetStatus }) {
  const { t } = useTranslation();
  return <span className={`${badge} ${STATUS_STYLE[status]}`}>{t(`assets.status.${status}`)}</span>;
}

const CONDITION_STYLE: Record<AssetCondition, string> = {
  good: 'border-success text-content',
  fair: 'border-border-subtle text-content',
  poor: 'border-warning bg-warning-subtle text-content',
  unusable: 'border-danger text-danger',
};

export function ConditionBadge({ condition }: { condition: AssetCondition | null }) {
  const { t } = useTranslation();
  if (condition === null) {
    return null;
  }
  return (
    <span className={`${badge} ${CONDITION_STYLE[condition]}`}>
      {t('assets.conditionLabel', { condition: t(`assets.condition.${condition}`) })}
    </span>
  );
}

/** Shown only when the warranty needs attention: ending soon, or ended. */
export function WarrantyBadge({ warranty }: { warranty: AssetRow['warranty'] }) {
  const { t } = useTranslation();
  if (warranty === 'expiring') {
    return (
      <span className={`${badge} border-warning bg-warning-subtle text-content`}>
        {t('assets.warranty.expiring')}
      </span>
    );
  }
  if (warranty === 'expired') {
    return (
      <span className={`${badge} border-danger text-danger`}>{t('assets.warranty.expired')}</span>
    );
  }
  return null;
}

/** A customer, then one of their sites. */
export function SitePicker({
  value,
  onChange,
}: {
  value: { customer: { id: string; name: string } | null; siteId: string };
  onChange: (value: { customer: { id: string; name: string } | null; siteId: string }) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const sites = useQuery({
    queryKey: ['sites', 'of', value.customer?.id ?? ''],
    queryFn: async () =>
      (
        await client.GET('/v1/sites', {
          params: { query: { customerId: value.customer!.id, limit: 200 } },
        })
      ).data!,
    enabled: value.customer !== null,
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <CustomerPicker
        label={t('assets.customer')}
        value={value.customer}
        onChange={(customer) => onChange({ customer, siteId: '' })}
      />
      <Field label={t('assets.site')}>
        {(id) => (
          <select
            id={id}
            required
            disabled={value.customer === null}
            className={inputClass}
            value={value.siteId}
            onChange={(event) => onChange({ ...value, siteId: event.target.value })}
          >
            <option value="">{t('assets.chooseSite')}</option>
            {(sites.data?.items ?? []).map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  );
}

export interface AssetDraft {
  name: string;
  make: string;
  model: string;
  serialNumber: string;
  locationNote: string;
  installDate: string;
  warrantyExpiresOn: string;
  notes: string;
}

export const emptyAssetDraft: AssetDraft = {
  name: '',
  make: '',
  model: '',
  serialNumber: '',
  locationNote: '',
  installDate: '',
  warrantyExpiresOn: '',
  notes: '',
};

/** The details form, shared by registering and editing. */
export function AssetFields({
  value,
  onChange,
}: {
  value: AssetDraft;
  onChange: (value: AssetDraft) => void;
}) {
  const { t } = useTranslation();
  const text = (key: keyof AssetDraft, max: number, ltr = false) => (
    <Field label={t(`assets.fields.${key}`)}>
      {(id) => (
        <input
          id={id}
          maxLength={max}
          dir={ltr ? 'ltr' : 'auto'}
          required={key === 'name'}
          className={inputClass}
          value={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  const date = (key: 'installDate' | 'warrantyExpiresOn') => (
    <Field label={t(`assets.fields.${key}`)}>
      {(id) => (
        <input
          id={id}
          type="date"
          dir="ltr"
          className={inputClass}
          value={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      )}
    </Field>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {text('name', 200)}
      {text('serialNumber', 200, true)}
      {text('make', 200)}
      {text('model', 200)}
      {text('locationNote', 500)}
      <div className="grid gap-3 sm:grid-cols-2">
        {date('installDate')}
        {date('warrantyExpiresOn')}
      </div>
      <div className="sm:col-span-2">
        <Field label={t('assets.fields.notes')}>
          {(id) => (
            <textarea
              id={id}
              rows={2}
              maxLength={2000}
              className={inputClass}
              value={value.notes}
              onChange={(event) => onChange({ ...value, notes: event.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

/** The body fields for what the draft says; blanks become null when editing. */
export function assetBody(draft: AssetDraft, editing: boolean) {
  const value = (text: string) => {
    const trimmed = text.trim();
    return trimmed === '' ? (editing ? null : undefined) : trimmed;
  };
  const entries = Object.entries({
    make: value(draft.make),
    model: value(draft.model),
    serialNumber: value(draft.serialNumber),
    locationNote: value(draft.locationNote),
    installDate: value(draft.installDate),
    warrantyExpiresOn: value(draft.warrantyExpiresOn),
    notes: value(draft.notes),
  }).filter(([, entry]) => entry !== undefined);
  return { name: draft.name.trim(), ...Object.fromEntries(entries) };
}

/**
 * Registers an asset: at a chosen site from the register, at a given site,
 * or at a job's site (which also links it to the job).
 */
export function NewAssetDialog({
  site,
  workOrderId,
  onClose,
  onDone,
}: {
  site?: { id: string; name: string; customer: { id: string; name: string } };
  workOrderId?: string;
  onClose: () => void;
  onDone?: (asset: AssetDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const queries = useQueryClient();
  const [place, setPlace] = useState<{
    customer: { id: string; name: string } | null;
    siteId: string;
  }>({ customer: null, siteId: '' });
  const [draft, setDraft] = useState<AssetDraft>(emptyAssetDraft);
  const [condition, setCondition] = useState<AssetCondition | ''>('');
  const fixed = site !== undefined || workOrderId !== undefined;
  const ready = draft.name.trim() !== '' && (fixed || place.siteId !== '');
  const body = {
    ...assetBody(draft, false),
    ...(workOrderId === undefined ? { siteId: site?.id ?? place.siteId } : { workOrderId }),
    ...(condition === '' ? {} : { condition }),
  };
  const idempotencyKey = useIdempotencyKey(body);
  const create = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/assets', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body,
        })
      ).data!,
    onSuccess: async (created) => {
      await queries.invalidateQueries({ queryKey: ['assets'] });
      if (onDone === undefined) {
        navigate(paths.asset(created.asset.id));
      } else {
        onDone(created);
      }
    },
  });

  return (
    <Dialog
      title={t('assets.new')}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('assets.cancel')}
          </button>
          <button
            type="submit"
            form="assets-new"
            className={buttonClass.primary}
            disabled={!ready || create.isPending}
          >
            {create.isPending ? t('assets.saving') : t('assets.register')}
          </button>
        </>
      }
    >
      <form
        id="assets-new"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            create.mutate();
          }
        }}
      >
        {site !== undefined ? (
          <p className="text-sm text-content">
            <span className="text-content-muted">{t('assets.site')}: </span>
            {site.customer.name} · {site.name}
          </p>
        ) : workOrderId !== undefined ? (
          <p className="text-sm text-content-muted">{t('assets.atJobSite')}</p>
        ) : (
          <SitePicker value={place} onChange={setPlace} />
        )}
        <AssetFields value={draft} onChange={setDraft} />
        <Field label={t('assets.conditionNow')}>
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={condition}
              onChange={(event) => setCondition(event.target.value as AssetCondition | '')}
            >
              <option value="">{t('assets.notRecorded')}</option>
              {ASSET_CONDITIONS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(`assets.condition.${candidate}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {create.isError ? <Failure error={create.error} /> : null}
      </form>
    </Dialog>
  );
}
