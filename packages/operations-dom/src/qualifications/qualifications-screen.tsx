import { QUALIFICATION_WARNING_DAYS_MAX, QUALIFICATION_WARNING_DAYS_MIN } from '@integr8/core';
import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useMemo, useState } from 'react';
import {
  keys,
  type QualificationList,
  type QualificationRecord,
  type QualificationType,
  useOperations,
} from '../api.js';
import {
  buttonClass,
  cardClass,
  DashboardBackLink,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  usePermissions,
} from '../ui.js';
import { formatDay, needsAttention, type RecordState, sortRecords } from './model.js';

/**
 * Skills and certificates (P26): the company's list of qualifications, how
 * early expiring certificates are warned about, and who holds what.
 *
 * Owners, admins and HR managers keep it (`qualification.manage`); the
 * dispatcher and anyone else who plans reads it. Someone who may read neither
 * — an engineer following an expiry email here — sees their own records.
 *
 * A renewal is a new record: the old one stays, expired, as the history of
 * what was held. "Renew" starts one for the same person and qualification.
 */

type View = 'records' | 'types';

export function QualificationsScreen() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const [view, setView] = useState<View>('records');

  if (permissions.length === 0) {
    return <Loading />;
  }
  if (!permissions.includes('qualification.read')) {
    return <MyQualifications />;
  }

  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-content">
            {t('operations.qualifications.title')}
          </h1>
          <p className="text-sm text-content-muted">
            {permissions.includes('qualification.manage')
              ? t('operations.qualifications.intro')
              : t('operations.qualifications.readOnly')}
          </p>
        </div>
        <div
          role="group"
          aria-label={t('operations.qualifications.view')}
          className="inline-flex rounded-md border border-border-subtle"
        >
          {(['records', 'types'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              className={`px-3 py-1.5 text-sm first:rounded-s-md last:rounded-e-md ${
                view === key
                  ? 'bg-accent text-on-accent'
                  : 'bg-surface text-content hover:bg-surface-muted'
              }`}
              onClick={() => setView(key)}
            >
              {t(`operations.qualifications.views.${key}`)}
            </button>
          ))}
        </div>
      </header>
      {view === 'records' ? <Records /> : <Types />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where a record stands
// ---------------------------------------------------------------------------

const STATE_STYLE: Record<RecordState, string> = {
  valid: 'border-success bg-success-subtle text-content',
  no_expiry: 'border-success bg-success-subtle text-content',
  expiring: 'border-warning bg-warning-subtle text-content',
  expired: 'border-danger bg-danger-subtle text-content',
  removed: 'border-border-subtle bg-surface-muted text-content-muted',
};

/** In words, never colour alone. */
export function QualificationStateBadge({ state }: { state: RecordState }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state]}`}
    >
      {t(`operations.qualifications.state.${state}`)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Who holds what
// ---------------------------------------------------------------------------

type RecordTarget =
  | { mode: 'new' }
  | { mode: 'renew'; from: QualificationRecord }
  | { mode: 'edit'; record: QualificationRecord };

function Records() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [person, setPerson] = useState('');
  const [type, setType] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [target, setTarget] = useState<RecordTarget | undefined>();

  const query = { person, type, removed };
  const records = useQuery({
    queryKey: keys.qualifications(query),
    queryFn: async () =>
      (
        await client.GET('/v1/qualifications', {
          params: {
            query: {
              ...(person === '' ? {} : { userId: person }),
              ...(type === '' ? {} : { qualificationTypeId: type }),
              ...(removed ? { includeRemoved: 'true' as const } : {}),
            },
          },
        })
      ).data!,
    placeholderData: (previous) => previous,
  });

  const data = records.data;
  const shown = useMemo(
    () =>
      data === undefined
        ? []
        : sortRecords(
            data.items.filter((record) => !urgent || needsAttention(record.state)),
            locale,
            urgent,
          ),
    [data, urgent, locale],
  );
  const people = useMemo(
    () => [...(data?.people ?? [])].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [data?.people, locale],
  );
  const manage = data?.can.manage ?? false;

  return (
    <section aria-labelledby="records-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="records-heading" className="text-lg font-semibold text-content">
          {t('operations.qualifications.records.title')}
        </h2>
        {manage ? (
          <button
            type="button"
            className={buttonClass.primary}
            onClick={() => setTarget({ mode: 'new' })}
          >
            {t('operations.qualifications.records.add')}
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('operations.qualifications.records.person')} className="min-w-48">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={person}
              onChange={(event) => setPerson(event.target.value)}
            >
              <option value="">{t('operations.qualifications.records.everyone')}</option>
              {people.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label={t('operations.qualifications.records.qualification')} className="min-w-48">
          {(id) => (
            <select
              id={id}
              className={inputClass}
              value={type}
              onChange={(event) => setType(event.target.value)}
            >
              <option value="">{t('operations.qualifications.records.allQualifications')}</option>
              {(data?.qualificationTypes ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={urgent}
            onChange={(event) => setUrgent(event.target.checked)}
          />
          {t('operations.qualifications.records.urgent')}
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-content">
          <input
            type="checkbox"
            checked={removed}
            onChange={(event) => setRemoved(event.target.checked)}
          />
          {t('operations.qualifications.records.showRemoved')}
        </label>
      </div>

      {data !== undefined ? (
        <p className="text-xs text-content-muted">
          {t('operations.qualifications.records.judged', {
            today: formatDay(data.today, locale),
            days: data.settings.warningDays,
          })}
        </p>
      ) : null}

      {records.isError && data === undefined ? (
        <Failure error={records.error} onRetry={() => void records.refetch()} />
      ) : data === undefined ? (
        <Loading />
      ) : shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {urgent
            ? t('operations.qualifications.records.noneUrgent')
            : t('operations.qualifications.records.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('operations.qualifications.records.title')}</caption>
            <thead className="border-b border-border-subtle text-xs text-content-muted">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.qualifications.records.person')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.qualifications.records.qualification')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.qualifications.records.reference')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.qualifications.records.expiresOn')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t('operations.qualifications.records.state')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-medium">
                  <span className="sr-only">{t('operations.qualifications.records.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {shown.map((record) => (
                <tr key={record.id}>
                  <td dir="auto" className="px-3 py-2 text-content">
                    {record.person.name}
                  </td>
                  <td className="px-3 py-2">
                    <span dir="auto" className="text-content">
                      {record.qualificationType.name}
                    </span>
                    <span className="block text-xs text-content-muted">
                      {t(`operations.qualifications.kind.${record.qualificationType.kind}`)}
                    </span>
                  </td>
                  <td dir="auto" className="px-3 py-2 text-content">
                    {record.reference ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-content">
                    {record.expiresOn === null
                      ? t('operations.qualifications.records.noExpiry')
                      : formatDay(record.expiresOn, locale)}
                  </td>
                  <td className="px-3 py-2">
                    <QualificationStateBadge state={record.state} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        onClick={() => setTarget({ mode: 'edit', record })}
                      >
                        {manage && record.state !== 'removed'
                          ? t('operations.common.edit')
                          : t('operations.qualifications.records.open')}{' '}
                        <span className="sr-only">
                          {t('operations.qualifications.records.rowName', {
                            name: record.person.name,
                            qualification: record.qualificationType.name,
                          })}
                        </span>
                      </button>
                      {manage &&
                      record.qualificationType.kind === 'certificate' &&
                      record.state !== 'removed' ? (
                        <button
                          type="button"
                          className={buttonClass.ghost}
                          onClick={() => setTarget({ mode: 'renew', from: record })}
                        >
                          {t('operations.qualifications.records.renew')}{' '}
                          <span className="sr-only">
                            {t('operations.qualifications.records.rowName', {
                              name: record.person.name,
                              qualification: record.qualificationType.name,
                            })}
                          </span>
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {target === undefined || data === undefined ? null : (
        <RecordDialog
          key={target.mode === 'edit' ? target.record.id : target.mode}
          target={target}
          data={data}
          manage={manage}
          onClose={() => setTarget(undefined)}
        />
      )}
    </section>
  );
}

function RecordDialog({
  target,
  data,
  manage,
  onClose,
}: {
  target: RecordTarget;
  data: QualificationList;
  manage: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const queryClient = useQueryClient();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const fileId = useId();

  const record = target.mode === 'edit' ? target.record : undefined;
  const from = target.mode === 'renew' ? target.from : undefined;
  const writable = manage && record?.state !== 'removed';

  const [userId, setUserId] = useState(record?.person.id ?? from?.person.id ?? '');
  const [typeId, setTypeId] = useState(
    record?.qualificationType.id ?? from?.qualificationType.id ?? '',
  );
  const [reference, setReference] = useState(record?.reference ?? '');
  const [issuedOn, setIssuedOn] = useState(record?.issuedOn ?? '');
  const [expiresOn, setExpiresOn] = useState(record?.expiresOn ?? '');
  const [notes, setNotes] = useState(record?.notes ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [removing, setRemoving] = useState(false);

  const liveTypes = data.qualificationTypes.filter((type) => !type.archived);
  const kind =
    record?.qualificationType.kind ??
    from?.qualificationType.kind ??
    data.qualificationTypes.find((type) => type.id === typeId)?.kind;
  const isSkill = kind === 'skill';
  const datesReversed = issuedOn !== '' && expiresOn !== '' && expiresOn < issuedOn;
  const ready = userId !== '' && typeId !== '' && !datesReversed;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['qualifications'] });

  const attachScan = async (recordId: string, scan: File) => {
    const contentType = scan.type === '' ? 'application/octet-stream' : scan.type;
    const uploaded = await media.upload(scan, { contentType });
    await client.POST('/v1/attachments', {
      params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: {
        owner: { memberQualificationId: recordId },
        fileId: uploaded.mediaId,
        title: (scan.name.trim() === '' ? 'Certificate' : scan.name.trim()).slice(0, 200),
        kind: contentType.startsWith('image/') ? 'photo' : 'other',
      },
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        reference: reference.trim() === '' ? null : reference.trim(),
        issuedOn: issuedOn === '' ? null : issuedOn,
        ...(isSkill ? {} : { expiresOn: expiresOn === '' ? null : expiresOn }),
        notes: notes.trim() === '' ? null : notes.trim(),
      };
      const saved =
        record === undefined
          ? (
              await client.POST('/v1/qualifications', {
                body: { userId, qualificationTypeId: typeId, ...fields },
              })
            ).data!
          : (
              await client.PATCH('/v1/qualifications/{qualificationId}', {
                params: { path: { qualificationId: record.id } },
                body: { expectedVersion: record.version, ...fields },
              })
            ).data!;
      if (file !== null) {
        await attachScan(saved.id, file);
      }
      return saved;
    },
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: async () =>
      client.POST('/v1/qualifications/{qualificationId}/remove', {
        params: { path: { qualificationId: record!.id } },
        body: { expectedVersion: record!.version },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const removeScan = useMutation({
    mutationFn: async (attachmentId: string) =>
      client.DELETE('/v1/attachments/{attachmentId}', { params: { path: { attachmentId } } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  const openScan = async (scan: QualificationRecord['attachments'][number]) => {
    const url = await media.url({
      mediaId: scan.fileId,
      contentType: scan.contentType,
      byteSize: scan.byteSize,
    });
    window.open(url, '_blank', 'noopener');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (writable && ready && !save.isPending) {
      save.mutate();
    }
  };

  const title =
    target.mode === 'new'
      ? t('operations.qualifications.record.newTitle')
      : target.mode === 'renew'
        ? t('operations.qualifications.record.renewTitle', {
            qualification: target.from.qualificationType.name,
            name: target.from.person.name,
          })
        : t('operations.qualifications.record.editTitle', {
            qualification: target.record.qualificationType.name,
            name: target.record.person.name,
          });
  const formId = `qualification-${record?.id ?? target.mode}`;

  return (
    <Dialog
      title={title}
      onClose={onClose}
      wide
      footer={
        removing ? (
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setRemoving(false)}
            >
              {t('operations.qualifications.record.keep')}
            </button>
            <button
              type="button"
              className={buttonClass.danger}
              disabled={remove.isPending}
              aria-busy={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('operations.qualifications.record.confirmRemove')}
            </button>
          </>
        ) : (
          <>
            {record !== undefined && writable ? (
              <button
                type="button"
                className={`${buttonClass.danger} me-auto`}
                onClick={() => setRemoving(true)}
              >
                {t('operations.qualifications.record.remove')}
              </button>
            ) : null}
            <button type="button" className={buttonClass.secondary} onClick={onClose}>
              {writable ? t('common.cancel') : t('common.close')}
            </button>
            {writable ? (
              <button
                type="submit"
                form={formId}
                className={buttonClass.primary}
                disabled={!ready || save.isPending}
                aria-busy={save.isPending}
              >
                {t('operations.qualifications.record.save')}
              </button>
            ) : null}
          </>
        )
      }
    >
      {record?.state === 'removed' ? (
        <p className="rounded-md border border-border-subtle bg-surface-muted px-3 py-2 text-content">
          {t('operations.qualifications.record.removedBy', {
            name: record.removedBy?.name ?? '',
          })}
        </p>
      ) : null}
      {target.mode === 'renew' ? (
        <p className="text-content-muted">{t('operations.qualifications.record.renewHint')}</p>
      ) : null}

      {removing ? (
        <p className="text-content">{t('operations.qualifications.record.removeHint')}</p>
      ) : (
        <form id={formId} onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label={t('operations.qualifications.records.person')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={userId}
                required
                disabled={!writable || target.mode !== 'new'}
                onChange={(event) => setUserId(event.target.value)}
              >
                <option value="" disabled>
                  {t('operations.qualifications.record.choosePerson')}
                </option>
                {data.people.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
                {/* Someone who has left the company keeps their records. */}
                {data.people.some((entry) => entry.id === userId) || userId === '' ? null : (
                  <option value={userId}>{record?.person.name ?? from?.person.name}</option>
                )}
              </select>
            )}
          </Field>
          <Field label={t('operations.qualifications.records.qualification')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={typeId}
                required
                disabled={!writable || target.mode !== 'new'}
                onChange={(event) => {
                  setTypeId(event.target.value);
                  if (
                    data.qualificationTypes.find((type) => type.id === event.target.value)?.kind ===
                    'skill'
                  ) {
                    setExpiresOn('');
                  }
                }}
              >
                <option value="" disabled>
                  {t('operations.qualifications.record.chooseQualification')}
                </option>
                {liveTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name} ({t(`operations.qualifications.kind.${type.kind}`)})
                  </option>
                ))}
                {liveTypes.some((type) => type.id === typeId) || typeId === '' ? null : (
                  <option value={typeId}>
                    {record?.qualificationType.name ?? from?.qualificationType.name}
                  </option>
                )}
              </select>
            )}
          </Field>
          <Field
            label={t('operations.qualifications.records.reference')}
            hint={t('operations.common.optional')}
          >
            {(id, describedBy) => (
              <input
                id={id}
                className={inputClass}
                value={reference}
                maxLength={120}
                disabled={!writable}
                aria-describedby={describedBy}
                onChange={(event) => setReference(event.target.value)}
              />
            )}
          </Field>
          <div className="hidden sm:block" />
          <Field label={t('operations.qualifications.record.issuedOn')}>
            {(id) => (
              <input
                id={id}
                type="date"
                className={inputClass}
                value={issuedOn}
                disabled={!writable}
                onChange={(event) => setIssuedOn(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('operations.qualifications.records.expiresOn')}
            hint={
              isSkill
                ? t('operations.qualifications.record.skillNoExpiry')
                : t('operations.qualifications.record.expiresHint')
            }
          >
            {(id, describedBy) => (
              <input
                id={id}
                type="date"
                className={inputClass}
                value={expiresOn}
                disabled={!writable || isSkill}
                aria-describedby={describedBy}
                aria-invalid={datesReversed}
                onChange={(event) => setExpiresOn(event.target.value)}
              />
            )}
          </Field>
          {datesReversed ? (
            <p className="text-sm text-danger sm:col-span-2">
              {t('operations.qualifications.record.datesReversed')}
            </p>
          ) : null}
          <Field label={t('operations.qualifications.record.notes')} className="sm:col-span-2">
            {(id) => (
              <textarea
                id={id}
                rows={2}
                className={inputClass}
                value={notes}
                maxLength={1000}
                disabled={!writable}
                onChange={(event) => setNotes(event.target.value)}
              />
            )}
          </Field>

          <fieldset className="flex flex-col gap-2 sm:col-span-2">
            <legend className="text-sm font-medium text-content">
              {t('operations.qualifications.record.scans')}
            </legend>
            {(record?.attachments ?? []).length === 0 ? (
              <p className="text-sm text-content-muted">
                {t('operations.qualifications.record.noScans')}
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle">
                {record!.attachments.map((scan) => (
                  <li
                    key={scan.id}
                    className="flex flex-wrap items-center justify-between gap-2 py-1.5"
                  >
                    <button
                      type="button"
                      dir="auto"
                      className="text-start text-accent underline-offset-4 hover:underline"
                      onClick={() => void openScan(scan)}
                    >
                      {scan.title}
                    </button>
                    <span className="text-xs text-content-muted">
                      {scan.addedBy.name} · {formatDay(scan.createdAt.slice(0, 10), locale)}
                    </span>
                    {writable ? (
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        disabled={removeScan.isPending}
                        onClick={() => removeScan.mutate(scan.id)}
                      >
                        {t('operations.common.remove')}{' '}
                        <span className="sr-only">{scan.title}</span>
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {writable ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={fileId} className="text-sm text-content">
                  {t('operations.qualifications.record.attachScan')}
                </label>
                <input
                  id={fileId}
                  type="file"
                  accept="image/*,application/pdf"
                  className="text-sm text-content"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
              </div>
            ) : null}
          </fieldset>
        </form>
      )}

      {save.isError ? <Failure error={save.error} /> : null}
      {remove.isError ? <Failure error={remove.error} /> : null}
      {removeScan.isError ? <Failure error={removeScan.error} /> : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The company's list
// ---------------------------------------------------------------------------

function Types() {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<QualificationType | 'new' | undefined>();

  const types = useQuery({
    queryKey: keys.qualificationTypes(archived),
    queryFn: async () =>
      (
        await client.GET('/v1/qualification-types', {
          params: { query: archived ? { includeArchived: 'true' } : {} },
        })
      ).data!,
  });
  const manage = types.data?.can.manage ?? false;

  const archive = useMutation({
    mutationFn: async (type: QualificationType) =>
      client.PATCH('/v1/qualification-types/{qualificationTypeId}', {
        params: { path: { qualificationTypeId: type.id } },
        body: { expectedVersion: type.version, archived: !type.archived },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['qualifications'] }),
  });

  return (
    <div className="flex flex-col gap-6">
      {types.data === undefined ? null : (
        <WarningPeriod warningDays={types.data.settings.warningDays} manage={manage} />
      )}

      <section aria-labelledby="types-heading" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="types-heading" className="text-lg font-semibold text-content">
            {t('operations.qualifications.types.title')}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              {t('operations.qualifications.types.showArchived')}
            </label>
            {manage ? (
              <button
                type="button"
                className={buttonClass.primary}
                onClick={() => setEditing('new')}
              >
                {t('operations.qualifications.types.add')}
              </button>
            ) : null}
          </div>
        </div>
        <p className="text-sm text-content-muted">{t('operations.qualifications.types.intro')}</p>

        {types.isError ? (
          <Failure error={types.error} onRetry={() => void types.refetch()} />
        ) : types.data === undefined ? (
          <Loading />
        ) : types.data.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-muted">
            {t('operations.qualifications.types.empty')}
          </p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {types.data.items.map((type) => (
              <li key={type.id} className={cardClass}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex flex-col">
                    <h3 dir="auto" className="font-semibold text-content">
                      {type.name}
                      {type.archived ? (
                        <span className="ms-2 text-sm font-normal text-content-muted">
                          ({t('operations.qualifications.archivedBadge')})
                        </span>
                      ) : null}
                    </h3>
                    <span className="text-xs text-content-muted">
                      {t(`operations.qualifications.kind.${type.kind}`)}
                    </span>
                  </div>
                  {manage ? (
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        onClick={() => setEditing(type)}
                      >
                        {t('operations.qualifications.types.rename')}{' '}
                        <span className="sr-only">{type.name}</span>
                      </button>
                      <button
                        type="button"
                        className={buttonClass.ghost}
                        disabled={archive.isPending}
                        onClick={() => archive.mutate(type)}
                      >
                        {type.archived
                          ? t('operations.qualifications.types.restore')
                          : t('operations.qualifications.types.archive')}{' '}
                        <span className="sr-only">{type.name}</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                {type.description === null ? null : (
                  <p dir="auto" className="text-sm text-content">
                    {type.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {archive.isError ? <Failure error={archive.error} /> : null}
      </section>

      {editing === undefined ? null : (
        <TypeDialog
          type={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}

function TypeDialog({
  type,
  onClose,
}: {
  type: QualificationType | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [name, setName] = useState(type?.name ?? '');
  const [kind, setKind] = useState<'skill' | 'certificate'>(type?.kind ?? 'certificate');
  const [description, setDescription] = useState(type?.description ?? '');

  const save = useMutation({
    mutationFn: async () => {
      const text = description.trim() === '' ? null : description.trim();
      return type === undefined
        ? client.POST('/v1/qualification-types', {
            body: { name: name.trim(), kind, description: text },
          })
        : client.PATCH('/v1/qualification-types/{qualificationTypeId}', {
            params: { path: { qualificationTypeId: type.id } },
            body: { expectedVersion: type.version, name: name.trim(), description: text },
          });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['qualifications'] });
      onClose();
    },
  });
  const formId = `qualification-type-${type?.id ?? 'new'}`;

  return (
    <Dialog
      title={
        type === undefined
          ? t('operations.qualifications.types.add')
          : t('operations.qualifications.types.renameTitle', { name: type.name })
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            className={buttonClass.primary}
            disabled={name.trim() === '' || save.isPending}
            aria-busy={save.isPending}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() !== '' && !save.isPending) {
            save.mutate();
          }
        }}
      >
        <Field label={t('operations.qualifications.types.name')}>
          {(id) => (
            <input
              id={id}
              required
              maxLength={120}
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium text-content">
            {t('operations.qualifications.types.kind')}
          </legend>
          {(['certificate', 'skill'] as const).map((option) => (
            <div key={option} className="flex flex-col">
              <label className="flex items-center gap-2 text-sm text-content">
                <input
                  type="radio"
                  name={`${formId}-kind`}
                  value={option}
                  checked={kind === option}
                  disabled={type !== undefined}
                  aria-describedby={`${formId}-${option}-hint`}
                  onChange={() => setKind(option)}
                />
                {t(`operations.qualifications.kind.${option}`)}
              </label>
              <span id={`${formId}-${option}-hint`} className="ps-6 text-xs text-content-muted">
                {t(`operations.qualifications.types.kindHint.${option}`)}
              </span>
            </div>
          ))}
          {type === undefined ? null : (
            <p className="text-xs text-content-muted">
              {t('operations.qualifications.types.kindFixed')}
            </p>
          )}
        </fieldset>
        <Field
          label={t('operations.qualifications.types.description')}
          hint={t('operations.common.optional')}
        >
          {(id, describedBy) => (
            <textarea
              id={id}
              rows={2}
              maxLength={1000}
              aria-describedby={describedBy}
              className={inputClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
      </form>
      {save.isError ? <Failure error={save.error} /> : null}
    </Dialog>
  );
}

/** How many days before a certificate runs out its holder and the managers are told. */
function WarningPeriod({ warningDays, manage }: { warningDays: number; manage: boolean }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(warningDays));
  const days = Math.trunc(Number(value));
  const valid =
    value !== '' &&
    Number.isFinite(days) &&
    days >= QUALIFICATION_WARNING_DAYS_MIN &&
    days <= QUALIFICATION_WARNING_DAYS_MAX;

  const save = useMutation({
    mutationFn: async () =>
      (await client.PATCH('/v1/qualification-settings', { body: { warningDays: days } })).data!,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['qualifications'] }),
  });

  return (
    <section aria-labelledby="warning-heading" className={cardClass}>
      <h2 id="warning-heading" className="text-lg font-semibold text-content">
        {t('operations.qualifications.warning.title')}
      </h2>
      {manage ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !save.isPending) {
              save.mutate();
            }
          }}
        >
          <Field
            label={t('operations.qualifications.warning.days')}
            hint={t('operations.qualifications.warning.hint', {
              min: QUALIFICATION_WARNING_DAYS_MIN,
              max: QUALIFICATION_WARNING_DAYS_MAX,
            })}
          >
            {(id, describedBy) => (
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={QUALIFICATION_WARNING_DAYS_MIN}
                max={QUALIFICATION_WARNING_DAYS_MAX}
                step={1}
                className={`${inputClass} w-32`}
                aria-describedby={describedBy}
                aria-invalid={!valid}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            )}
          </Field>
          <button
            type="submit"
            className={buttonClass.secondary}
            disabled={!valid || save.isPending || days === warningDays}
            aria-busy={save.isPending}
          >
            {t('common.save')}
          </button>
          {save.isSuccess && days === save.data.warningDays ? (
            <span role="status" className="pb-2 text-sm text-content-muted">
              {t('operations.common.saved')}
            </span>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-content">
          {t('operations.qualifications.warning.readOnly', { days: warningDays })}
        </p>
      )}
      {save.isError ? <Failure error={save.error} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One's own
// ---------------------------------------------------------------------------

/** What someone who cannot read everybody's records sees: their own. */
function MyQualifications() {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const mine = useQuery({
    queryKey: ['qualifications', 'mine'],
    queryFn: async () => (await client.GET('/v1/me/qualifications')).data!,
  });
  return (
    <div className="flex flex-col gap-6 text-start">
      <DashboardBackLink />
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-content">
          {t('operations.qualifications.mine.title')}
        </h1>
        <p className="text-sm text-content-muted">{t('operations.qualifications.mine.intro')}</p>
      </header>
      {mine.isError ? (
        <Failure error={mine.error} onRetry={() => void mine.refetch()} />
      ) : mine.data === undefined ? (
        <Loading />
      ) : mine.data.items.length === 0 ? (
        <p className="py-8 text-center text-sm text-content-muted">
          {t('operations.qualifications.mine.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sortRecords(mine.data.items, locale, true).map((record) => (
            <li key={record.id} className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span dir="auto" className="font-semibold text-content">
                  {record.qualificationType.name}
                </span>
                <QualificationStateBadge state={record.state} />
              </div>
              <p className="text-sm text-content-muted">
                {record.expiresOn === null
                  ? t('operations.qualifications.records.noExpiry')
                  : t('operations.qualifications.mine.expires', {
                      date: formatDay(record.expiresOn, locale),
                    })}
                {record.reference === null ? '' : ` · ${record.reference}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-content-muted">{t('operations.qualifications.mine.askManager')}</p>
    </div>
  );
}
