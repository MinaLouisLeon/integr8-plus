import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { ASSET_CONDITIONS, ASSET_STATUSES } from '@integr8/core';
import { formatCalendarDate, formatDate, formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useMemo, useState } from 'react';
import {
  type AssetCondition,
  type AssetDetail,
  type AssetStatus,
  type AssetTimelineEntry,
  keys,
  useOperations,
} from '../api.js';
import {
  BackLink,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  StateBadge,
} from '../ui.js';
import {
  type AssetDraft,
  assetBody,
  AssetFields,
  AssetStatusBadge,
  ConditionBadge,
  SitePicker,
  WarrantyBadge,
} from './asset-parts.js';
import { LotList } from '../inventory/lots.js';
import { AssetTagSheet } from './asset-tag.js';
import { AssetPlansSection } from '../maintenance/asset-plans.js';

/**
 * One asset (CRM/ERP plan, phase E3; ADR-0008): what it is and where, its
 * jobs, and everything it has been through, newest first — with editing,
 * moving, retiring and a new tag for the office, and recording its condition
 * and adding a photo for whoever records assets.
 */
export function AssetScreen({ assetId }: { assetId: string }) {
  const { t } = useTranslation();
  const { client, paths, navigate, locale } = useOperations();
  const queries = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'move' | 'status' | 'condition' | null>(null);

  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const detail = useQuery({
    queryKey: keys.asset(assetId),
    queryFn: async () =>
      (await client.GET('/v1/assets/{assetId}', { params: { path: { assetId } } })).data!,
  });
  const timeline = useQuery({
    queryKey: keys.assetTimeline(assetId),
    queryFn: async () =>
      (await client.GET('/v1/assets/{assetId}/timeline', { params: { path: { assetId } } })).data!,
  });
  const settle = async (next?: AssetDetail) => {
    if (next !== undefined) {
      queries.setQueryData(keys.asset(assetId), next);
    }
    await queries.invalidateQueries({ queryKey: ['assets'] });
  };
  const reissue = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/assets/{assetId}/tag', {
          params: { path: { assetId } },
          body: { expectedVersion: detail.data!.asset.version },
        })
      ).data!,
    onSuccess: settle,
  });

  if (detail.isPending) {
    return <Loading />;
  }
  const back = <BackLink to={paths.assets} label={t('assets.back')} />;
  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4 text-start">
        {back}
        <Failure error={detail.error} onRetry={() => void detail.refetch()} />
      </div>
    );
  }

  const { asset, workOrders, can } = detail.data;
  const company = me.data?.company?.name ?? '';
  const link = (href: string, label: ReactNode) => (
    <a
      href={href}
      className="text-accent underline-offset-4 hover:underline"
      onClick={(event) => {
        event.preventDefault();
        navigate(href);
      }}
    >
      {label}
    </a>
  );
  const fact = (label: string, value: ReactNode) =>
    value === null || value === '' ? null : (
      <div className="flex flex-col">
        <dt className="text-content-muted">{label}</dt>
        <dd className="text-content">{value}</dd>
      </div>
    );

  return (
    <>
      <AssetTagSheet tags={[asset]} company={company} />
      <div className="flex flex-col gap-6 text-start print:hidden">
        {back}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold text-content">
              <span dir="ltr">{asset.reference}</span>
              <span dir="auto">{asset.name}</span>
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <AssetStatusBadge status={asset.status} />
              <ConditionBadge condition={asset.condition} />
              <WarrantyBadge warranty={asset.warranty} />
            </p>
            <p className="text-sm text-content-muted">
              {link(paths.customer(asset.customer.id), asset.customer.name)}
              {' · '}
              {link(paths.site(asset.site.id), asset.site.name)}
              {asset.locationNote === null ? null : ` · ${asset.locationNote}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {can.record ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setDialog('condition')}
              >
                {t('assets.recordCondition')}
              </button>
            ) : null}
            {can.edit ? (
              <>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('edit')}
                >
                  {t('assets.edit')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('move')}
                >
                  {t('assets.move')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => setDialog('status')}
                >
                  {t('assets.changeStatus')}
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  disabled={reissue.isPending}
                  onClick={() => {
                    if (window.confirm(t('assets.reissueConfirm'))) {
                      reissue.mutate();
                    }
                  }}
                >
                  {t('assets.reissueTag')}
                </button>
              </>
            ) : null}
          </div>
        </header>

        {reissue.isError ? <Failure error={reissue.error} /> : null}

        <section className={cardClass} aria-labelledby="asset-details">
          <h2 id="asset-details" className="sr-only">
            {t('assets.details')}
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            {fact(t('assets.fields.make'), asset.make)}
            {fact(t('assets.fields.model'), asset.model)}
            {fact(
              t('assets.fields.serialNumber'),
              asset.serialNumber === null ? null : <span dir="ltr">{asset.serialNumber}</span>,
            )}
            {fact(
              t('assets.item'),
              asset.item === null ? null : `${asset.item.sku} · ${asset.item.name}`,
            )}
            {fact(
              t('assets.fields.installDate'),
              asset.installDate === null ? null : formatCalendarDate(asset.installDate, { locale }),
            )}
            {fact(
              t('assets.fields.warrantyExpiresOn'),
              asset.warrantyExpiresOn === null
                ? null
                : formatCalendarDate(asset.warrantyExpiresOn, { locale }),
            )}
            {fact(
              t('assets.lastCondition'),
              asset.condition === null || asset.conditionRecordedAt === null
                ? null
                : t('assets.conditionBy', {
                    condition: t(`assets.condition.${asset.condition}`),
                    name: asset.conditionRecordedBy?.name ?? '',
                    date: formatDateTime(asset.conditionRecordedAt, { locale }),
                  }),
            )}
            {fact(
              t('assets.tagCode'),
              <span dir="ltr" className="font-mono">
                {asset.tagCode}
              </span>,
            )}
            {fact(
              t('assets.fields.notes'),
              asset.notes === null ? null : (
                <span className="whitespace-pre-wrap" dir="auto">
                  {asset.notes}
                </span>
              ),
            )}
          </dl>
        </section>

        <section className="flex flex-col gap-3" aria-labelledby="asset-jobs">
          <h2 id="asset-jobs" className="text-lg font-semibold text-content">
            {t('assets.jobs')}
          </h2>
          {workOrders.length === 0 ? (
            <p className="text-sm text-content-muted">{t('assets.noJobs')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle bg-surface text-sm">
              {workOrders.map((job) => (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
                >
                  {link(paths.workOrder(job.id), `${job.referenceLabel} · ${job.title}`)}
                  <span className="flex items-center gap-2 text-xs text-content-muted">
                    <StateBadge state={job.state} />
                    {formatDate(job.linkedAt, { locale })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <AssetPlansSection asset={asset} />

        {can.attach ? <AssetPhoto assetId={asset.id} onDone={() => void settle()} /> : null}

        <section className="flex flex-col gap-3" aria-labelledby="asset-timeline">
          <h2 id="asset-timeline" className="text-lg font-semibold text-content">
            {t('assets.timeline')}
          </h2>
          {timeline.isPending ? (
            <Loading />
          ) : timeline.isError ? (
            <Failure error={timeline.error} onRetry={() => void timeline.refetch()} />
          ) : timeline.data.entries.length === 0 ? (
            <p className="text-sm text-content-muted">{t('assets.noHistory')}</p>
          ) : (
            <ol className="flex flex-col gap-0 border-s border-border-subtle ps-4">
              {timeline.data.entries.map((entry) => (
                <TimelineItem key={`${entry.kind}-${entry.id}`} entry={entry} />
              ))}
            </ol>
          )}
        </section>

        {dialog === 'edit' ? (
          <EditDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'move' ? (
          <MoveDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'status' ? (
          <StatusDialog detail={detail.data} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
        {dialog === 'condition' ? (
          <ConditionDialog assetId={asset.id} onClose={() => setDialog(null)} onDone={settle} />
        ) : null}
      </div>
    </>
  );
}

/** One line of history, in words, with who and when. */
function TimelineItem({ entry }: { entry: AssetTimelineEntry }) {
  const { t } = useTranslation();
  const { paths, navigate, locale } = useOperations();
  const when = formatDateTime(entry.at, { locale });
  const jobLink = (workOrderId: string | null) =>
    workOrderId === null ? null : (
      <a
        href={paths.workOrder(workOrderId)}
        className="text-accent underline-offset-4 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.workOrder(workOrderId));
        }}
      >
        {t('assets.onJob')}
      </a>
    );
  let what: ReactNode;
  let who = '';
  let extra: ReactNode = null;
  switch (entry.kind) {
    case 'event': {
      const event = entry.event;
      who = event.by.name;
      what =
        event.kind === 'relocated'
          ? t('assets.events.relocated', {
              site: event.fromSite?.name ?? '',
              customer: event.fromSite?.customer.name ?? '',
            })
          : event.kind === 'status_changed'
            ? t('assets.events.status_changed', {
                from: t(`assets.status.${event.fromStatus ?? 'active'}`),
                to: t(`assets.status.${event.toStatus ?? 'active'}`),
              })
            : event.kind === 'condition_recorded'
              ? t('assets.events.condition_recorded', {
                  condition: t(`assets.condition.${event.condition ?? 'good'}`),
                })
              : event.kind === 'updated'
                ? t('assets.events.updated', {
                    fields: Object.keys(event.changes ?? {})
                      .map((field) => t(`assets.fields.${field}`, { defaultValue: field }))
                      .join(', '),
                  })
                : t(`assets.events.${event.kind}`);
      extra = (
        <>
          {event.note === null ? null : (
            <span className="block whitespace-pre-wrap text-content" dir="auto">
              {event.note}
            </span>
          )}
          {jobLink(event.workOrderId)}
        </>
      );
      break;
    }
    case 'job':
      what = t('assets.entries.job', {
        reference: entry.workOrder.referenceLabel,
        title: entry.workOrder.title,
      });
      extra = (
        <span className="flex items-center gap-2">
          <StateBadge state={entry.workOrder.state} />
          {jobLink(entry.workOrder.id)}
        </span>
      );
      break;
    case 'submission':
      who = entry.submission.by.name;
      what = t('assets.entries.submission', { form: entry.submission.form.name });
      extra = (
        <span className="flex flex-wrap items-center gap-2">
          <a
            href={paths.submission(entry.submission.id)}
            className="text-accent underline-offset-4 hover:underline"
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.submission(entry.submission.id));
            }}
          >
            {t('assets.openSubmission')}
          </a>
          {entry.submission.photos.length === 0
            ? null
            : t('assets.photoCount', { count: entry.submission.photos.length })}
          {jobLink(entry.submission.workOrderId)}
        </span>
      );
      break;
    case 'part':
      who = entry.part.by.name;
      what = t('assets.entries.part', {
        quantity: entry.part.quantity,
        item: entry.part.item.name,
      });
      // The serial numbers fitted, each opening its trace (ADR-0013).
      extra = (
        <>
          <LotList lots={entry.part.lots} unit={entry.part.item.unit} />
          {jobLink(entry.part.workOrderId)}
        </>
      );
      break;
    case 'attachment':
      who = entry.attachment.addedBy.name;
      what = t('assets.entries.attachment', { title: entry.attachment.title });
      extra = jobLink(entry.attachment.workOrderId);
      break;
  }
  return (
    <li className="relative pb-4 text-sm">
      <span
        aria-hidden="true"
        className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-accent"
      />
      <p className="text-content">{what}</p>
      <p className="text-xs text-content-muted">
        {who === '' ? when : t('assets.byOn', { name: who, date: when })}
      </p>
      {extra === null ? null : <div className="mt-1 flex flex-col gap-1 text-xs">{extra}</div>}
    </li>
  );
}

function draftOf(detail: AssetDetail): AssetDraft {
  const { asset } = detail;
  return {
    name: asset.name,
    make: asset.make ?? '',
    model: asset.model ?? '',
    serialNumber: asset.serialNumber ?? '',
    locationNote: asset.locationNote ?? '',
    installDate: asset.installDate ?? '',
    warrantyExpiresOn: asset.warrantyExpiresOn ?? '',
    notes: asset.notes ?? '',
  };
}

function DialogFrame({
  id,
  title,
  ready,
  pending,
  error,
  onClose,
  onSubmit,
  children,
  wide = false,
}: {
  id: string;
  title: string;
  ready: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={title}
      wide={wide}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('assets.cancel')}
          </button>
          <button
            type="submit"
            form={id}
            className={buttonClass.primary}
            disabled={!ready || pending}
          >
            {pending ? t('assets.saving') : t('assets.save')}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            onSubmit();
          }
        }}
      >
        {children}
        {error === null ? null : <Failure error={error} />}
      </form>
    </Dialog>
  );
}

function EditDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: AssetDetail;
  onClose: () => void;
  onDone: (next: AssetDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [draft, setDraft] = useState(draftOf(detail));
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PATCH('/v1/assets/{assetId}', {
          params: { path: { assetId: detail.asset.id } },
          body: { expectedVersion: detail.asset.version, ...assetBody(draft, true) },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <DialogFrame
      id="assets-edit"
      title={t('assets.edit')}
      wide
      ready={draft.name.trim() !== ''}
      pending={save.isPending}
      error={save.error}
      onClose={onClose}
      onSubmit={() => save.mutate()}
    >
      <AssetFields value={draft} onChange={setDraft} />
    </DialogFrame>
  );
}

function MoveDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: AssetDetail;
  onClose: () => void;
  onDone: (next: AssetDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [place, setPlace] = useState<{
    customer: { id: string; name: string } | null;
    siteId: string;
  }>({
    customer: detail.asset.customer,
    siteId: '',
  });
  const [note, setNote] = useState('');
  const move = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/assets/{assetId}/relocate', {
          params: { path: { assetId: detail.asset.id } },
          body: {
            expectedVersion: detail.asset.version,
            siteId: place.siteId,
            ...(note.trim() === '' ? {} : { note: note.trim() }),
          },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <DialogFrame
      id="assets-move"
      title={t('assets.move')}
      wide
      ready={place.siteId !== '' && place.siteId !== detail.asset.site.id}
      pending={move.isPending}
      error={move.error}
      onClose={onClose}
      onSubmit={() => move.mutate()}
    >
      <p className="text-sm text-content-muted">
        {t('assets.moveIntro', { site: detail.asset.site.name })}
      </p>
      <SitePicker value={place} onChange={setPlace} />
      <NoteField value={note} onChange={setNote} />
    </DialogFrame>
  );
}

function StatusDialog({
  detail,
  onClose,
  onDone,
}: {
  detail: AssetDetail;
  onClose: () => void;
  onDone: (next: AssetDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [status, setStatus] = useState<AssetStatus>(detail.asset.status);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/assets/{assetId}/status', {
          params: { path: { assetId: detail.asset.id } },
          body: {
            expectedVersion: detail.asset.version,
            status,
            ...(note.trim() === '' ? {} : { note: note.trim() }),
          },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <DialogFrame
      id="assets-status"
      title={t('assets.changeStatus')}
      ready={status !== detail.asset.status}
      pending={save.isPending}
      error={save.error}
      onClose={onClose}
      onSubmit={() => save.mutate()}
    >
      <Field label={t('assets.statusLabel')}>
        {(id) => (
          <select
            id={id}
            className={inputClass}
            value={status}
            onChange={(event) => setStatus(event.target.value as AssetStatus)}
          >
            {ASSET_STATUSES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`assets.status.${candidate}`)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <NoteField value={note} onChange={setNote} />
    </DialogFrame>
  );
}

export function ConditionDialog({
  assetId,
  workOrderId,
  onClose,
  onDone,
}: {
  assetId: string;
  workOrderId?: string;
  onClose: () => void;
  onDone: (next: AssetDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [condition, setCondition] = useState<AssetCondition | ''>('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/assets/{assetId}/condition', {
          params: { path: { assetId } },
          body: {
            condition: condition as AssetCondition,
            ...(note.trim() === '' ? {} : { note: note.trim() }),
            ...(workOrderId === undefined ? {} : { workOrderId }),
          },
        })
      ).data!,
    onSuccess: async (next) => {
      onClose();
      await onDone(next);
    },
  });
  return (
    <DialogFrame
      id="assets-condition"
      title={t('assets.recordCondition')}
      ready={condition !== ''}
      pending={save.isPending}
      error={save.error}
      onClose={onClose}
      onSubmit={() => save.mutate()}
    >
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="mb-1 text-sm font-medium text-content">
          {t('assets.conditionNow')}
        </legend>
        {ASSET_CONDITIONS.map((candidate) => (
          <label key={candidate} className="flex items-center gap-2">
            <input
              type="radio"
              name="asset-condition"
              checked={condition === candidate}
              onChange={() => setCondition(candidate)}
            />
            {t(`assets.condition.${candidate}`)}
          </label>
        ))}
      </fieldset>
      <NoteField value={note} onChange={setNote} />
    </DialogFrame>
  );
}

function NoteField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <Field label={t('assets.note')}>
      {(id) => (
        <textarea
          id={id}
          rows={2}
          maxLength={1000}
          className={inputClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** A photo or document kept on the asset itself: the rating plate, a manual. */
function AssetPhoto({ assetId, onDone }: { assetId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queries = useQueryClient();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const fileId = useId();
  const attach = useMutation({
    mutationFn: async () => {
      if (file === null) {
        return;
      }
      const reference = await media.upload(file, {
        contentType: file.type || 'application/octet-stream',
      });
      await client.POST('/v1/attachments', {
        params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
        body: {
          owner: { assetId },
          fileId: reference.mediaId,
          title: title.trim() === '' ? file.name : title.trim(),
          kind: file.type.startsWith('image/') ? 'photo' : 'manual',
        },
      });
    },
    onSuccess: async () => {
      setFile(null);
      setTitle('');
      await queries.invalidateQueries({ queryKey: keys.assetTimeline(assetId) });
      onDone();
    },
  });
  return (
    <section className={cardClass} aria-labelledby="asset-attach">
      <h2 id="asset-attach" className="mb-2 text-base font-semibold text-content">
        {t('assets.addFile')}
      </h2>
      <form
        className="grid gap-2 sm:grid-cols-4 sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          attach.mutate();
        }}
      >
        <div className="flex flex-col gap-1 sm:col-span-2">
          <label htmlFor={fileId} className="text-sm font-medium text-content">
            {t('assets.file')}
          </label>
          <input
            id={fileId}
            type="file"
            className="text-sm text-content"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <Field label={t('assets.fileTitle')}>
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <button
          type="submit"
          className={buttonClass.secondary}
          disabled={file === null || attach.isPending}
        >
          {attach.isPending ? t('assets.saving') : t('assets.attach')}
        </button>
      </form>
      {attach.isError ? <Failure error={attach.error} /> : null}
    </section>
  );
}
