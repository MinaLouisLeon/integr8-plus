import { ApiRequestError } from '@integr8/api-client';
import { apiMediaAdapter } from '@integr8/form-renderer-dom/screens';
import { jobTimes } from '@integr8/core';
import { formatDateTime, useTranslation } from '@integr8/i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { AccessNotesPanel } from '../access-notes.js';
import { keys, useOperations, type WorkOrderDetail, type WorkOrderState } from '../api.js';
import { CrewPicker, type CrewMember } from '../crew.js';
import {
  addressText,
  buttonClass,
  cardClass,
  Dialog,
  Failure,
  Field,
  inputClass,
  Loading,
  PriorityBadge,
  StateBadge,
  useDuration,
  when,
} from '../ui.js';

/**
 * One job.
 *
 * Getting in comes first — before the title, before the buttons — because an
 * engineer opens this in the van outside the gate. Then what state the job is
 * in and what this person may do next, then what the job is, who is on it, the
 * forms and checklist, files, notes and history.
 *
 * The buttons offered are exactly the transitions the server says this person
 * may make now. The server checks again on every one, and says why when it
 * refuses — a required form not yet submitted is named.
 */
export function WorkOrderScreen({ workOrderId }: { workOrderId: string }) {
  const { t } = useTranslation();
  const { client, locale, paths, navigate } = useOperations();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: keys.workOrder(workOrderId),
    queryFn: async () =>
      (await client.GET('/v1/work-orders/{workOrderId}', { params: { path: { workOrderId } } }))
        .data!,
  });

  const refresh = (next: WorkOrderDetail) => {
    queryClient.setQueryData(keys.workOrder(workOrderId), next);
    void queryClient.invalidateQueries({ queryKey: ['work-orders', 'list'] });
  };

  if (detail.isPending) {
    return <Loading />;
  }
  if (detail.isError) {
    return <Failure error={detail.error} onRetry={() => void detail.refetch()} />;
  }

  const job = detail.data;
  const { workOrder, site, customer } = job;

  return (
    <div className="flex flex-col gap-6 text-start">
      <a
        href={paths.workOrders}
        className="text-sm text-accent underline-offset-4 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.workOrders);
        }}
      >
        <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
          ←
        </span>{' '}
        {t('operations.workOrder.back')}
      </a>

      <AccessNotesPanel
        access={site.access}
        locale={locale}
        {...(job.can.work
          ? {
              onSave: async (input) => {
                await client.PUT('/v1/sites/{siteId}/access', {
                  params: { path: { siteId: site.id } },
                  body: input,
                });
                await detail.refetch();
              },
            }
          : {})}
      />

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-content-muted">{workOrder.referenceLabel}</span>
          <StateBadge state={workOrder.state} />
          <PriorityBadge priority={workOrder.priority} />
        </div>
        <h1 dir="auto" className="text-2xl font-semibold text-content">
          {workOrder.title}
        </h1>
        <p className="text-sm text-content-muted">
          {customer.name} · {site.name} · {addressText(site.address)}
        </p>
      </header>

      <Transitions job={job} onChanged={refresh} />

      <div className="grid gap-4 lg:grid-cols-3">
        <section aria-labelledby="details-heading" className={`${cardClass} lg:col-span-2`}>
          <h2 id="details-heading" className="text-lg font-semibold text-content">
            {t('operations.workOrder.details')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Detail label={t('operations.workOrder.customer')}>
              <a
                href={paths.customer(customer.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.customer(customer.id));
                }}
              >
                {customer.name}
              </a>
              {customer.phone === null ? null : (
                <span dir="ltr" className="block text-content-muted">
                  {customer.phone}
                </span>
              )}
            </Detail>
            <Detail label={t('operations.workOrder.site')}>
              <a
                href={paths.site(site.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.site(site.id));
                }}
              >
                {site.name}
              </a>
              <span dir="auto" className="block text-content-muted">
                {addressText(site.address)}
              </span>
              {site.location === null ? null : (
                <a
                  className="text-xs text-accent underline-offset-4 hover:underline"
                  href={`https://www.openstreetmap.org/?mlat=${String(site.location.latitude)}&mlon=${String(site.location.longitude)}#map=18/${String(site.location.latitude)}/${String(site.location.longitude)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('operations.location.openMap')}
                </a>
              )}
            </Detail>
            {job.siteContact === null ? null : (
              <Detail label={t('operations.workOrder.contact')}>
                {job.siteContact.name}
                {[job.siteContact.phone, job.siteContact.email]
                  .filter((value): value is string => value !== null)
                  .map((value) => (
                    <span key={value} dir="ltr" className="block text-content-muted">
                      {value}
                    </span>
                  ))}
              </Detail>
            )}
            <Detail label={t('operations.workOrder.jobType')}>
              {job.jobType.name}
              {job.jobType.expectedDurationMinutes === null ? null : (
                <span className="block text-content-muted">
                  {t('operations.workOrder.expectedDuration', {
                    minutes: job.jobType.expectedDurationMinutes,
                  })}
                </span>
              )}
            </Detail>
            <Detail label={t('operations.workOrder.dueWindow')}>
              <DueWindow from={workOrder.dueFrom} by={workOrder.dueBy} locale={locale} />
            </Detail>
          </dl>
          {job.workOrder.description === null ? null : (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium text-content-muted">
                {t('operations.workOrder.description')}
              </h3>
              <p dir="auto" className="whitespace-pre-wrap text-sm text-content">
                {job.workOrder.description}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium text-content-muted">
              {t('operations.workOrder.instructions')}
            </h3>
            <p dir="auto" className="whitespace-pre-wrap text-sm text-content">
              {job.workOrder.instructions ?? t('operations.workOrder.noInstructions')}
            </p>
          </div>
        </section>

        <Crew job={job} onChanged={refresh} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Forms job={job} onChanged={refresh} />
        <Checklist job={job} onChanged={refresh} />
      </div>

      <Completion job={job} />
      <Attachments job={job} onChanged={() => void detail.refetch()} />
      <Comments job={job} onChanged={refresh} />
      <History job={job} />
      <Previous job={job} />
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <dt className="text-content-muted">{label}</dt>
      <dd className="text-content">{children}</dd>
    </div>
  );
}

export function DueWindow({
  from,
  by,
  locale,
}: {
  from: string | null;
  by: string | null;
  locale: string;
}) {
  const { t } = useTranslation();
  if (from !== null && by !== null) {
    return (
      <>
        {t('operations.workOrder.dueBetween', { from: when(from, locale), by: when(by, locale) })}
      </>
    );
  }
  if (by !== null) {
    return <>{t('operations.workOrder.dueBy', { by: when(by, locale) })}</>;
  }
  if (from !== null) {
    return <>{t('operations.workOrder.dueFromOnly', { from: when(from, locale) })}</>;
  }
  return <>{t('operations.workOrders.noDue')}</>;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function transitionLabel(
  from: WorkOrderState,
  to: WorkOrderState,
):
  | 'operations.transition.reopen'
  | 'operations.transition.reinstate'
  | `operations.transition.${WorkOrderState}` {
  if (from === 'complete' && to === 'in_progress') {
    return 'operations.transition.reopen';
  }
  if (from === 'cancelled' && to === 'scheduled') {
    return 'operations.transition.reinstate';
  }
  return `operations.transition.${to}`;
}

function Transitions({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState<WorkOrderState | undefined>(undefined);
  const [reason, setReason] = useState('');

  const move = useMutation({
    mutationFn: async ({ to, why }: { to: WorkOrderState; why?: string }) =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/transitions', {
          params: { path: { workOrderId: job.workOrder.id } },
          body: {
            to,
            expectedRevision: job.workOrder.revision,
            ...(why === undefined || why === '' ? {} : { reason: why }),
          },
        })
      ).data!,
    onSuccess: (next) => {
      setAsking(undefined);
      setReason('');
      onChanged(next);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.code === 'work_order_changed') {
        void queryClient.invalidateQueries({ queryKey: keys.workOrder(job.workOrder.id) });
      }
    },
  });

  if (job.can.transitions.length === 0) {
    return null;
  }

  const primary = (to: WorkOrderState) =>
    !['cancelled', 'scheduled', 'dispatched'].includes(to) || job.workOrder.state === 'scheduled';

  return (
    <section aria-label={t('operations.transition.label')} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {job.can.transitions.map((transition) => (
          <button
            key={transition.to}
            type="button"
            className={
              transition.to === 'cancelled'
                ? buttonClass.danger
                : primary(transition.to)
                  ? buttonClass.primary
                  : buttonClass.secondary
            }
            disabled={move.isPending}
            onClick={() => {
              if (transition.requiresReason) {
                setAsking(transition.to);
              } else {
                move.mutate({ to: transition.to });
              }
            }}
          >
            {t(transitionLabel(job.workOrder.state, transition.to))}
          </button>
        ))}
      </div>
      {move.isError && asking === undefined ? <TransitionFailure error={move.error} /> : null}

      {asking === undefined ? null : (
        <Dialog
          title={t(transitionLabel(job.workOrder.state, asking))}
          onClose={() => setAsking(undefined)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setAsking(undefined)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                form="transition-reason"
                className={asking === 'cancelled' ? buttonClass.danger : buttonClass.primary}
                disabled={reason.trim() === '' || move.isPending}
                aria-busy={move.isPending}
              >
                {t('operations.transition.confirm')}
              </button>
            </>
          }
        >
          <form
            id="transition-reason"
            onSubmit={(event) => {
              event.preventDefault();
              move.mutate({ to: asking, why: reason.trim() });
            }}
          >
            <Field
              label={t('operations.transition.reasonLabel')}
              hint={t('operations.transition.reasonHint')}
            >
              {(id, describedBy) => (
                <textarea
                  id={id}
                  aria-describedby={describedBy}
                  required
                  rows={3}
                  className={inputClass}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
          </form>
          {move.isError ? <TransitionFailure error={move.error} /> : null}
        </Dialog>
      )}
    </section>
  );
}

type Missing = WorkOrderDetail['execution']['missing'];

/**
 * What a refused completion names, read from the error's details: one per
 * required form, the before and after photos still needed, and the sign-off.
 * A detail this screen does not know is kept in the server's own words.
 */
function missingFromError(error: ApiRequestError): {
  missing: Missing;
  other: { key: string; text: string }[];
} {
  const missing: Missing = { forms: [], beforePhotos: 0, afterPhotos: 0, signoff: false };
  const other: { key: string; text: string }[] = [];
  error.details.forEach((detail, index) => {
    const params = detail.params ?? {};
    const needed = Number(params.needed);
    if (detail.code === 'required_form_missing') {
      missing.forms.push({
        formId: typeof params.formId === 'string' ? params.formId : detail.field,
        title: detail.message,
      });
    } else if (detail.code === 'photos_missing' && detail.field === 'photos.before' && needed > 0) {
      missing.beforePhotos = needed;
    } else if (detail.code === 'photos_missing' && detail.field === 'photos.after' && needed > 0) {
      missing.afterPhotos = needed;
    } else if (detail.code === 'signoff_missing') {
      missing.signoff = true;
    } else {
      other.push({ key: `${detail.field}-${String(index)}`, text: detail.message });
    }
  });
  return { missing, other };
}

function MissingItems({
  missing,
  other = [],
}: {
  missing: Missing;
  other?: { key: string; text: string }[];
}) {
  const { t } = useTranslation();
  return (
    <ul className="list-disc ps-5 text-sm text-content">
      {missing.forms.map((form) => (
        <li key={`form-${form.formId}`} dir="auto">
          {t('operations.workOrder.missing.form', { title: form.title })}
        </li>
      ))}
      {missing.beforePhotos > 0 ? (
        <li>{t('operations.workOrder.missing.beforePhotos', { count: missing.beforePhotos })}</li>
      ) : null}
      {missing.afterPhotos > 0 ? (
        <li>{t('operations.workOrder.missing.afterPhotos', { count: missing.afterPhotos })}</li>
      ) : null}
      {missing.signoff ? <li>{t('operations.workOrder.missing.signoff')}</li> : null}
      {other.map((entry) => (
        <li key={entry.key}>{entry.text}</li>
      ))}
    </ul>
  );
}

function TransitionFailure({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (error instanceof ApiRequestError && error.code === 'completion_blocked') {
    const { missing, other } = missingFromError(error);
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-md border border-danger bg-danger-subtle p-3 text-start text-sm text-content"
      >
        <p>{error.message}</p>
        <MissingItems missing={missing} other={other} />
      </div>
    );
  }
  if (error instanceof ApiRequestError && error.code === 'work_order_changed') {
    return (
      <p role="alert" className="text-sm text-danger">
        {t('operations.workOrder.changed')}
      </p>
    );
  }
  return <Failure error={error} />;
}

// ---------------------------------------------------------------------------
// Crew
// ---------------------------------------------------------------------------

function Crew({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const [editing, setEditing] = useState(false);
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const save = useMutation({
    mutationFn: async () =>
      (
        await client.PUT('/v1/work-orders/{workOrderId}/crew', {
          params: { path: { workOrderId: job.workOrder.id } },
          body: { crew },
        })
      ).data!,
    onSuccess: (next) => {
      setEditing(false);
      onChanged(next);
    },
  });

  return (
    <section aria-labelledby="crew-heading" className={cardClass}>
      <div className="flex items-center justify-between gap-2">
        <h2 id="crew-heading" className="text-lg font-semibold text-content">
          {t('operations.workOrder.crew')}
        </h2>
        {job.can.assign && job.can.edit ? (
          <button
            type="button"
            className={buttonClass.ghost}
            onClick={() => {
              setCrew(job.crew.map((member) => ({ userId: member.id, lead: member.lead })));
              setEditing(true);
            }}
          >
            {t('operations.workOrder.editCrew')}
          </button>
        ) : null}
      </div>
      {job.crew.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.workOrders.noCrew')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {job.crew.map((member) => (
            <li key={member.id} className="flex items-center gap-2 text-content">
              {member.name}
              {member.lead ? (
                <span className="rounded-full border border-accent px-2 text-xs text-content">
                  {t('operations.workOrder.lead')}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <Dialog
          title={t('operations.workOrder.editCrew')}
          onClose={() => setEditing(false)}
          footer={
            <>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setEditing(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={buttonClass.primary}
                disabled={save.isPending}
                aria-busy={save.isPending}
                onClick={() => save.mutate()}
              >
                {t('common.save')}
              </button>
            </>
          }
        >
          <CrewPicker value={crew} onChange={setCrew} />
          {save.isError ? <Failure error={save.error} /> : null}
        </Dialog>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Forms and checklist
// ---------------------------------------------------------------------------

function Forms({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, navigate, paths } = useOperations();
  const [adding, setAdding] = useState(false);
  const [formId, setFormId] = useState('');
  const [required, setRequired] = useState(true);
  const forms = useQuery({
    queryKey: keys.forms,
    queryFn: async () => (await client.GET('/v1/forms')).data!.items,
    enabled: adding,
  });

  const start = useMutation({
    mutationFn: async (id: string) =>
      (
        await client.POST('/v1/submissions', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { formId: id, workOrderId: job.workOrder.id },
        })
      ).data!,
    onSuccess: (draft) => navigate(paths.submission(draft.submission.id)),
  });
  const add = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/forms', {
          params: { path: { workOrderId: job.workOrder.id } },
          body: { formId, required },
        })
      ).data!,
    onSuccess: (next) => {
      setAdding(false);
      setFormId('');
      onChanged(next);
    },
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      (
        await client.DELETE('/v1/work-orders/{workOrderId}/forms/{formId}', {
          params: { path: { workOrderId: job.workOrder.id, formId: id } },
        })
      ).data!,
    onSuccess: onChanged,
  });

  const closed = ['complete', 'reviewed', 'cancelled'].includes(job.workOrder.state);

  return (
    <section aria-labelledby="forms-heading" className={cardClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="forms-heading" className="text-lg font-semibold text-content">
          {t('operations.workOrder.forms')}
        </h2>
        <a
          href={paths.submissionsForWorkOrder(job.workOrder.id)}
          className="text-sm text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.submissionsForWorkOrder(job.workOrder.id));
          }}
        >
          {t('operations.workOrder.submissionsForJob')}
        </a>
      </div>
      <ul className="flex flex-col divide-y divide-border-subtle">
        {job.forms.map((form) => (
          <li key={form.formId} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium text-content">{form.title}</span>
              <span className="text-xs text-content-muted">
                {form.required
                  ? t('operations.workOrder.required')
                  : t('operations.workOrder.optional')}{' '}
                ·{' '}
                {form.submission === null
                  ? t('operations.workOrder.notStarted')
                  : t(`submissions.status.${form.submission.status}`)}
              </span>
            </div>
            <div className="flex gap-2">
              {form.submission !== null ? (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => navigate(paths.submission(form.submission!.id))}
                >
                  {form.submission.status === 'draft' && job.can.work
                    ? t('operations.workOrder.continue')
                    : t('operations.workOrder.view')}
                </button>
              ) : job.can.work && !closed ? (
                <button
                  type="button"
                  className={buttonClass.primary}
                  disabled={start.isPending}
                  onClick={() => start.mutate(form.formId)}
                >
                  {t('operations.workOrder.fill')}
                </button>
              ) : null}
              {form.submission === null && job.can.edit ? (
                <button
                  type="button"
                  className={buttonClass.ghost}
                  aria-label={`${t('operations.workOrder.removeForm')} ${form.title}`}
                  onClick={() => remove.mutate(form.formId)}
                >
                  {t('operations.workOrder.removeForm')}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {start.isError ? <Failure error={start.error} /> : null}
      {remove.isError ? <Failure error={remove.error} /> : null}
      {job.can.edit ? (
        adding ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate();
            }}
          >
            <Field label={t('operations.workOrder.addForm')}>
              {(id) => (
                <select
                  id={id}
                  className={inputClass}
                  value={formId}
                  onChange={(event) => setFormId(event.target.value)}
                >
                  <option value="">{t('operations.jobTypes.chooseForm')}</option>
                  {forms.data
                    ?.filter((form) => form.latestVersionNumber !== null)
                    .map((form) => (
                      <option key={form.id} value={form.id}>
                        {form.title}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <label className="flex items-center gap-2 text-sm text-content">
              <input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />
              {t('operations.jobTypes.requiredForm')}
            </label>
            <div className="flex gap-2">
              <button
                type="submit"
                className={buttonClass.primary}
                disabled={formId === '' || add.isPending}
              >
                {t('operations.common.add')}
              </button>
              <button
                type="button"
                className={buttonClass.secondary}
                onClick={() => setAdding(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
            {add.isError ? <Failure error={add.error} /> : null}
          </form>
        ) : (
          <button
            type="button"
            className={`${buttonClass.ghost} self-start`}
            onClick={() => setAdding(true)}
          >
            + {t('operations.workOrder.addForm')}
          </button>
        )
      ) : null}
    </section>
  );
}

function Checklist({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [label, setLabel] = useState('');
  const inputId = useId();
  const toggle = useMutation({
    mutationFn: async ({ itemId, done }: { itemId: string; done: boolean }) =>
      (
        await client.PATCH('/v1/work-orders/{workOrderId}/checklist/{itemId}', {
          params: { path: { workOrderId: job.workOrder.id, itemId } },
          body: { done },
        })
      ).data!,
    onSuccess: onChanged,
  });
  const add = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/checklist', {
          params: { path: { workOrderId: job.workOrder.id } },
          body: { label },
        })
      ).data!,
    onSuccess: (next) => {
      setLabel('');
      onChanged(next);
    },
  });

  if (job.checklist.length === 0 && !job.can.edit) {
    return null;
  }

  return (
    <section aria-labelledby="checklist-heading" className={cardClass}>
      <h2 id="checklist-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.checklist')}
      </h2>
      <ul className="flex flex-col gap-2">
        {job.checklist.map((item) => (
          <li key={item.id} className="flex flex-col">
            <label className="flex items-start gap-2 text-sm text-content">
              <input
                type="checkbox"
                className="mt-1"
                checked={
                  toggle.isPending && toggle.variables.itemId === item.id
                    ? toggle.variables.done
                    : item.done
                }
                disabled={!job.can.work || toggle.isPending}
                onChange={(event) => toggle.mutate({ itemId: item.id, done: event.target.checked })}
              />
              <span className={item.done ? 'text-content-muted line-through' : ''}>
                {item.label}
              </span>
            </label>
            {item.done && item.doneBy !== null ? (
              <span className="ps-6 text-xs text-content-muted">
                {t('operations.workOrder.checklistDone', {
                  name: item.doneBy.name,
                  when: when(item.doneAt, locale),
                })}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {toggle.isError ? <Failure error={toggle.error} /> : null}
      {job.can.edit ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim() !== '') {
              add.mutate();
            }
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            {t('operations.workOrder.addChecklistItem')}
          </label>
          <input
            id={inputId}
            className={inputClass}
            value={label}
            placeholder={t('operations.workOrder.addChecklistItem')}
            onChange={(event) => setLabel(event.target.value)}
          />
          <button
            type="submit"
            className={buttonClass.secondary}
            disabled={label.trim() === '' || add.isPending}
          >
            {t('operations.common.add')}
          </button>
        </form>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Completion: photos, sign-off, what is missing, time on the job
// ---------------------------------------------------------------------------

const CLOSED: readonly WorkOrderState[] = ['complete', 'reviewed', 'cancelled'];

/**
 * What the engineer did on site, as the office checks it: the before and after
 * photos against what the job type asks for, the customer's sign-off, what the
 * job still needs before it can be completed, and the time spent — added up by
 * `jobTimes`, the same rule the phone and the timesheets use.
 */
function Completion({ job }: { job: WorkOrderDetail }) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const duration = useDuration();
  const { execution } = job;
  const { signoff } = execution;
  const closed = CLOSED.includes(job.workOrder.state);

  const changes = job.events.flatMap((event) =>
    event.kind === 'transitioned' && event.fromState !== null && event.toState !== null
      ? [{ fromState: event.fromState, toState: event.toState, occurredAt: event.occurredAt }]
      : [],
  );
  const times = jobTimes(changes, new Date());
  const open = async (fileId: string, contentType: string, byteSize: number) => {
    const url = await media.url({ mediaId: fileId, contentType, byteSize });
    window.open(url, '_blank', 'noopener');
  };

  return (
    <section aria-labelledby="completion-heading" className={cardClass}>
      <h2 id="completion-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.completion.title')}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        {(['before', 'after'] as const).map((stage) => {
          const needed = stage === 'before' ? execution.beforePhotos : execution.afterPhotos;
          const photos = job.attachments.filter((attachment) => attachment.stage === stage);
          return (
            <div key={stage} className="flex flex-col gap-1 text-sm">
              <h3 className="font-medium text-content-muted">
                {t(`operations.workOrder.completion.${stage}Photos`)}
              </h3>
              <p className="text-content">
                {needed > 0
                  ? t('operations.workOrder.completion.photosOf', {
                      taken: photos.length,
                      needed,
                    })
                  : photos.length === 0
                    ? t('operations.workOrder.completion.photosNotNeeded')
                    : t('operations.workOrder.completion.photosTaken', { count: photos.length })}
              </p>
              {photos.length === 0 ? null : (
                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                  {photos.map((photo) => (
                    <li key={photo.id}>
                      <button
                        type="button"
                        dir="auto"
                        className="text-start text-accent underline-offset-4 hover:underline"
                        onClick={() => void open(photo.fileId, photo.contentType, photo.byteSize)}
                      >
                        {photo.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        <div className="flex flex-col items-start gap-1 text-sm">
          <h3 className="font-medium text-content-muted">
            {t('operations.workOrder.completion.signoff')}
          </h3>
          {signoff === null ? (
            <p className="text-content">
              {execution.signatureRequired
                ? t('operations.workOrder.completion.notSigned')
                : t('operations.workOrder.completion.notRequired')}
            </p>
          ) : (
            <>
              <p dir="auto" className="text-content">
                {signoff.unavailableReason !== null
                  ? t('operations.workOrder.completion.nobodySigned', {
                      reason: signoff.unavailableReason,
                    })
                  : signoff.role === null
                    ? t('operations.workOrder.completion.signed', { name: signoff.name ?? '' })
                    : t('operations.workOrder.completion.signedWithRole', {
                        name: signoff.name ?? '',
                        role: signoff.role,
                      })}
              </p>
              <p className="text-xs text-content-muted">
                {t('operations.workOrder.completion.recordedBy', {
                  name: signoff.signedBy.name,
                  when: when(signoff.signedAt, locale),
                })}
              </p>
              {signoff.fileId === null ? null : (
                <button
                  type="button"
                  className={buttonClass.secondary}
                  onClick={() => {
                    if (signoff.fileId !== null) {
                      void open(signoff.fileId, 'image/png', 0);
                    }
                  }}
                >
                  {t('operations.workOrder.completion.viewSignature')}
                </button>
              )}
            </>
          )}
        </div>

        {closed ? null : (
          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-medium text-content-muted">
              {t('operations.workOrder.missing.title')}
            </h3>
            {execution.missing.forms.length === 0 &&
            execution.missing.beforePhotos === 0 &&
            execution.missing.afterPhotos === 0 &&
            !execution.missing.signoff ? (
              <p className="text-content">{t('operations.workOrder.missing.none')}</p>
            ) : (
              <MissingItems missing={execution.missing} />
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <h3 className="font-medium text-content-muted">
          {t('operations.workOrder.completion.time')}
        </h3>
        {changes.length === 0 ? (
          <p className="text-content">{t('operations.workOrder.completion.noTime')}</p>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-4">
            {(
              [
                ['travel', times.travelMs],
                ['onSite', times.onSiteMs],
                ['working', times.workMs],
                ['waiting', times.waitingMs],
              ] as const
            ).map(([label, ms]) => (
              <Detail key={label} label={t(`operations.workOrder.completion.${label}`)}>
                {duration(ms)}
              </Detail>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Files, notes, history
// ---------------------------------------------------------------------------

function Attachments({ job, onChanged }: { job: WorkOrderDetail; onChanged: () => void }) {
  const { t } = useTranslation();
  const { client } = useOperations();
  const media = useMemo(() => apiMediaAdapter(client), [client]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'site_plan' | 'manual' | 'report' | 'photo' | 'other'>('other');
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const fileId = useId();

  const attach = useMutation({
    mutationFn: async () => {
      if (file === null) {
        return;
      }
      const reference = await media.upload(file, {
        contentType: file.type || 'application/octet-stream',
        onProgress: setProgress,
      });
      await client.POST('/v1/attachments', {
        params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
        body: {
          owner: { workOrderId: job.workOrder.id },
          fileId: reference.mediaId,
          title: title || file.name,
          kind,
        },
      });
    },
    onSuccess: () => {
      setFile(null);
      setTitle('');
      setProgress(undefined);
      onChanged();
    },
    onError: () => setProgress(undefined),
  });
  const remove = useMutation({
    mutationFn: async (attachmentId: string) =>
      client.DELETE('/v1/attachments/{attachmentId}', { params: { path: { attachmentId } } }),
    onSuccess: onChanged,
  });
  const open = async (attachmentFileId: string, contentType: string, byteSize: number) => {
    const url = await media.url({ mediaId: attachmentFileId, contentType, byteSize });
    window.open(url, '_blank', 'noopener');
  };

  return (
    <section aria-labelledby="files-heading" className={cardClass}>
      <h2 id="files-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.attachments')}
      </h2>
      {job.attachments.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.workOrder.noAttachments')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle">
          {job.attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <button
                type="button"
                className="text-start text-accent underline-offset-4 hover:underline"
                onClick={() =>
                  void open(attachment.fileId, attachment.contentType, attachment.byteSize)
                }
              >
                {attachment.title}
              </button>
              <span className="text-xs text-content-muted">
                {t(`operations.workOrder.kind.${attachment.kind}`)}
                {attachment.stage === null
                  ? ''
                  : ` · ${t(`operations.workOrder.stage.${attachment.stage}`)}`}{' '}
                · {attachment.addedBy.name}
              </span>
              {job.can.work ? (
                <button
                  type="button"
                  className={buttonClass.ghost}
                  onClick={() => remove.mutate(attachment.id)}
                >
                  {t('operations.workOrder.removeAttachment')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {job.can.work ? (
        <form
          className="grid gap-2 sm:grid-cols-4 sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            attach.mutate();
          }}
        >
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label htmlFor={fileId} className="text-sm font-medium text-content">
              {t('operations.workOrder.attach')}
            </label>
            <input
              id={fileId}
              type="file"
              className="text-sm text-content"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <Field label={t('operations.workOrder.attachTitle')}>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('operations.workOrder.attachKind')}>
            {(id) => (
              <select
                id={id}
                className={inputClass}
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                {(['site_plan', 'manual', 'report', 'photo', 'other'] as const).map((option) => (
                  <option key={option} value={option}>
                    {t(`operations.workOrder.kind.${option}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="flex items-center gap-3 sm:col-span-4">
            <button
              type="submit"
              className={buttonClass.secondary}
              disabled={file === null || attach.isPending}
              aria-busy={attach.isPending}
            >
              {t('operations.workOrder.attach')}
            </button>
            {progress === undefined ? null : (
              <progress
                max={1}
                value={progress}
                className="w-40"
                aria-label={t('operations.workOrder.attach')}
              />
            )}
          </div>
          {attach.isError ? <Failure error={attach.error} /> : null}
        </form>
      ) : null}
    </section>
  );
}

function Comments({
  job,
  onChanged,
}: {
  job: WorkOrderDetail;
  onChanged: (next: WorkOrderDetail) => void;
}) {
  const { t } = useTranslation();
  const { client, locale } = useOperations();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'customer'>('internal');
  const add = useMutation({
    mutationFn: async () =>
      (
        await client.POST('/v1/work-orders/{workOrderId}/comments', {
          params: {
            path: { workOrderId: job.workOrder.id },
            header: { 'Idempotency-Key': crypto.randomUUID() },
          },
          body: { body, visibility },
        })
      ).data!,
    onSuccess: (next) => {
      setBody('');
      onChanged(next);
    },
  });

  return (
    <section aria-labelledby="notes-heading" className={cardClass}>
      <h2 id="notes-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.comments')}
      </h2>
      {job.comments.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.workOrder.noComments')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {job.comments.map((comment) => (
            <li
              key={comment.id}
              className={`flex flex-col gap-1 rounded-md border p-3 ${comment.visibility === 'customer' ? 'border-accent' : 'border-border-subtle bg-surface-muted'}`}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-content-muted">
                <span className="font-medium text-content">{comment.author.name}</span>
                <span>{when(comment.createdAt, locale)}</span>
                <span className="rounded-full border border-border-subtle px-2">
                  {comment.visibility === 'customer'
                    ? t('operations.workOrder.customerVisible')
                    : t('operations.workOrder.internal')}
                </span>
              </div>
              <p dir="auto" className="whitespace-pre-wrap text-sm text-content">
                {comment.body}
              </p>
            </li>
          ))}
        </ol>
      )}
      {job.can.comment ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim() !== '') {
              add.mutate();
            }
          }}
        >
          <Field label={t('operations.workOrder.commentLabel')}>
            {(id) => (
              <textarea
                id={id}
                rows={3}
                className={inputClass}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            )}
          </Field>
          <fieldset className="flex flex-wrap gap-4 text-sm text-content">
            <legend className="sr-only">{t('operations.workOrder.comments')}</legend>
            {(['internal', 'customer'] as const).map((option) => (
              <label key={option} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="comment-visibility"
                  checked={visibility === option}
                  onChange={() => setVisibility(option)}
                />
                {option === 'customer'
                  ? t('operations.workOrder.customerVisible')
                  : t('operations.workOrder.internal')}
              </label>
            ))}
          </fieldset>
          <div>
            <button
              type="submit"
              className={buttonClass.secondary}
              disabled={body.trim() === '' || add.isPending}
            >
              {t('operations.workOrder.addComment')}
            </button>
          </div>
          {add.isError ? <Failure error={add.error} /> : null}
        </form>
      ) : null}
    </section>
  );
}

/** How far behind `occurredAt` an event may be recorded before the history says so. */
const RECORDED_LATE_MS = 60_000;

function History({ job }: { job: WorkOrderDetail }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  return (
    <section aria-labelledby="history-heading" className={cardClass}>
      <h2 id="history-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.history')}
      </h2>
      <ol className="flex flex-col gap-2 text-sm">
        {job.events.map((event, index) => {
          const unavailable =
            event.kind === 'signed_off' && typeof event.details.unavailableReason === 'string'
              ? event.details.unavailableReason
              : undefined;
          // Recorded on a phone without signal and synced later: say both.
          const late =
            Date.parse(event.recordedAt) - Date.parse(event.occurredAt) > RECORDED_LATE_MS;
          return (
            <li key={`${event.occurredAt}-${String(index)}`} className="flex flex-col">
              <span dir="auto" className="text-content">
                {unavailable === undefined
                  ? t(`operations.workOrder.event.${event.kind}`, {
                      actor: event.actor.name,
                      person: event.person?.name ?? '',
                      name: typeof event.details.name === 'string' ? event.details.name : '',
                      from:
                        event.fromState === null ? '' : t(`operations.state.${event.fromState}`),
                      to: event.toState === null ? '' : t(`operations.state.${event.toState}`),
                      fields: Array.isArray(event.details.fields)
                        ? (event.details.fields as string[]).join(', ')
                        : '',
                    })
                  : t('operations.workOrder.nobodySignedEvent', {
                      actor: event.actor.name,
                      reason: unavailable,
                    })}
              </span>
              <span className="text-xs text-content-muted">
                {formatDateTime(event.occurredAt, { locale })}
                {event.reason === null ? '' : ` — ${event.reason}`}
              </span>
              {late ? (
                <span className="text-xs italic text-content-muted">
                  {t('operations.workOrder.recordedLater', {
                    occurred: formatDateTime(event.occurredAt, { locale }),
                    recorded: formatDateTime(event.recordedAt, { locale }),
                  })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Previous({ job }: { job: WorkOrderDetail }) {
  const { t } = useTranslation();
  const { navigate, paths, locale } = useOperations();
  return (
    <section aria-labelledby="previous-heading" className={cardClass}>
      <h2 id="previous-heading" className="text-lg font-semibold text-content">
        {t('operations.workOrder.previous')}
      </h2>
      {job.previousAtSite.length === 0 ? (
        <p className="text-sm text-content-muted">{t('operations.workOrder.noPrevious')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-subtle text-sm">
          {job.previousAtSite.map((earlier) => (
            <li key={earlier.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <a
                href={paths.workOrder(earlier.id)}
                className="text-accent underline-offset-4 hover:underline"
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.workOrder(earlier.id));
                }}
              >
                {earlier.referenceLabel} · {earlier.title}
              </a>
              <span className="flex items-center gap-2 text-xs text-content-muted">
                <StateBadge state={earlier.state} />
                {when(earlier.createdAt, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
