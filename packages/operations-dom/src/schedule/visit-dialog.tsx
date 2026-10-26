import { findDoubleBookings, type PlannedVisit, visitWarnings } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  type ScheduleJob,
  type SchedulePerson,
  type ScheduleVisit,
  useOperations,
} from '../api.js';
import {
  buttonClass,
  Dialog,
  Failure,
  Field,
  fromLocalInput,
  inputClass,
  PriorityBadge,
  toLocalInput,
  when,
} from '../ui.js';
import { personColour } from './model.js';

/**
 * Planning one visit, or looking at and changing one (P25).
 *
 * The dialog is also the keyboard's way to do everything the calendar does by
 * dragging: set the times, choose who goes, cancel. It warns before saving
 * when someone would be on another job at the same time — the server refuses
 * that anyway, for every client — and says when a visit falls outside the
 * job's due window, which is allowed.
 */

export type VisitDialogTarget =
  | { kind: 'new'; job: ScheduleJob; startsAt: Date; endsAt: Date }
  | { kind: 'edit'; job: ScheduleJob; visit: ScheduleVisit };

export function toPlanned(visit: ScheduleVisit): PlannedVisit {
  return {
    id: visit.id,
    workOrderId: visit.workOrderId,
    status: visit.status,
    startsAt: new Date(visit.startsAt),
    endsAt: new Date(visit.endsAt),
    assigneeIds: visit.assignees.map((person) => person.id),
  };
}

export function VisitDialog({
  target,
  people,
  colourOf,
  visits,
  referenceOf,
  canPlan,
  onClose,
  onSaved,
}: {
  target: VisitDialogTarget;
  people: readonly SchedulePerson[];
  colourOf: (personId: string) => number;
  /** Everything loaded on the board, to warn about clashes before saving. */
  visits: readonly ScheduleVisit[];
  referenceOf: (workOrderId: string) => string;
  canPlan: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { client, locale, navigate, paths } = useOperations();
  const editing = target.kind === 'edit' ? target.visit : undefined;
  const open = editing === undefined || editing.status === 'planned';
  const writable = canPlan && open;
  const crew = new Set(target.job.crew.map((member) => member.id));

  const [startsAt, setStartsAt] = useState(
    toLocalInput(editing?.startsAt ?? (target.kind === 'new' ? target.startsAt.toISOString() : '')),
  );
  const [endsAt, setEndsAt] = useState(
    toLocalInput(editing?.endsAt ?? (target.kind === 'new' ? target.endsAt.toISOString() : '')),
  );
  const [chosen, setChosen] = useState<string[]>(
    editing?.assignees.map((person) => person.id) ??
      target.job.crew.filter((member) => member.lead).map((member) => member.id),
  );
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');

  const start = fromLocalInput(startsAt);
  const end = fromLocalInput(endsAt);
  const slotValid = start !== null && end !== null && Date.parse(end) > Date.parse(start);

  // Some people may have left the company since they were put on a visit: keep them listed.
  const listed = [
    ...people,
    ...(editing?.assignees ?? [])
      .filter((person) => !people.some((known) => known.id === person.id))
      .map((person) => ({ ...person, role: '' })),
  ];
  const nameOf = (id: string) => listed.find((person) => person.id === id)?.name ?? '';

  const candidate: PlannedVisit | undefined = slotValid
    ? {
        id: editing?.id ?? 'new',
        workOrderId: target.job.id,
        status: 'planned',
        startsAt: new Date(start),
        endsAt: new Date(end),
        assigneeIds: chosen,
      }
    : undefined;
  const clashes =
    candidate === undefined || !writable
      ? []
      : findDoubleBookings(candidate, visits.map(toPlanned));
  const warnings =
    candidate === undefined
      ? []
      : visitWarnings(candidate, {
          dueFrom: target.job.dueFrom === null ? null : new Date(target.job.dueFrom),
          dueBy: target.job.dueBy === null ? null : new Date(target.job.dueBy),
        });

  const save = useMutation({
    mutationFn: async () => {
      const addToCrew = chosen.some((id) => !crew.has(id));
      if (editing === undefined) {
        return client.POST('/v1/work-orders/{workOrderId}/visits', {
          params: { path: { workOrderId: target.job.id } },
          body: {
            startsAt: start!,
            endsAt: end!,
            assigneeIds: chosen,
            notes: notes.trim() === '' ? null : notes.trim(),
            addToCrew,
          },
        });
      }
      return client.PATCH('/v1/visits/{visitId}', {
        params: { path: { visitId: editing.id } },
        body: {
          expectedRevision: editing.revision,
          startsAt: start!,
          endsAt: end!,
          assigneeIds: chosen,
          notes: notes.trim() === '' ? null : notes.trim(),
          addToCrew,
        },
      });
    },
    onSuccess: onSaved,
  });

  const cancel = useMutation({
    mutationFn: async () =>
      client.POST('/v1/visits/{visitId}/cancel', {
        params: { path: { visitId: editing!.id } },
        body: {
          expectedRevision: editing!.revision,
          reason: reason.trim() === '' ? null : reason.trim(),
        },
      }),
    onSuccess: onSaved,
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (writable && slotValid && !save.isPending) {
      save.mutate();
    }
  };

  const formId = `visit-${editing?.id ?? 'new'}`;
  const title =
    editing === undefined
      ? t('operations.schedule.dialog.newTitle')
      : t('operations.schedule.dialog.editTitle', { reference: target.job.referenceLabel });

  return (
    <Dialog
      title={title}
      onClose={onClose}
      wide
      footer={
        cancelling ? (
          <>
            <button
              type="button"
              className={buttonClass.secondary}
              onClick={() => setCancelling(false)}
            >
              {t('operations.schedule.dialog.keep')}
            </button>
            <button
              type="button"
              className={buttonClass.danger}
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t('operations.schedule.dialog.confirmCancel')}
            </button>
          </>
        ) : (
          <>
            {editing !== undefined && writable ? (
              <button
                type="button"
                className={`${buttonClass.danger} me-auto`}
                onClick={() => setCancelling(true)}
              >
                {t('operations.schedule.dialog.cancelVisit')}
              </button>
            ) : null}
            <button type="button" className={buttonClass.secondary} onClick={onClose}>
              {t('operations.schedule.dialog.close')}
            </button>
            {writable ? (
              <button
                type="submit"
                form={formId}
                className={buttonClass.primary}
                disabled={!slotValid || save.isPending}
              >
                {t('operations.schedule.dialog.save')}
              </button>
            ) : null}
          </>
        )
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-content-muted">
          {t('operations.schedule.dialog.job')}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span dir="auto" className="font-medium text-content">
            {target.job.referenceLabel} · {target.job.title}
          </span>
          <PriorityBadge priority={target.job.priority} />
        </div>
        <span dir="auto" className="text-content-muted">
          {target.job.customer.name} · {target.job.site.name}
        </span>
        <a
          href={paths.workOrder(target.job.id)}
          className="self-start text-sm text-accent underline-offset-4 hover:underline"
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.workOrder(target.job.id));
          }}
        >
          {t('operations.schedule.dialog.openJob')}
        </a>
      </div>

      {editing?.status === 'done' && editing.completedAt !== null ? (
        <p className="rounded-md border border-success bg-success-subtle px-3 py-2 text-content">
          {t('operations.schedule.dialog.doneBy', {
            name: editing.completedBy?.name ?? '',
            time: when(editing.completedAt, locale),
          })}
        </p>
      ) : null}
      {editing?.status === 'cancelled' ? (
        <p className="rounded-md border border-border-subtle bg-surface-muted px-3 py-2 text-content">
          {t('operations.schedule.dialog.cancelledBecause', {
            reason: editing.cancelReason ?? t('operations.schedule.cancelled'),
          })}
        </p>
      ) : null}

      {cancelling ? (
        <Field label={t('operations.schedule.dialog.cancelReason')}>
          {(id) => (
            <input
              id={id}
              className={inputClass}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      ) : (
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('operations.schedule.dialog.starts')}>
              {(id) => (
                <input
                  id={id}
                  type="datetime-local"
                  className={inputClass}
                  value={startsAt}
                  step={900}
                  disabled={!writable}
                  required
                  onChange={(event) => setStartsAt(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('operations.schedule.dialog.ends')}>
              {(id) => (
                <input
                  id={id}
                  type="datetime-local"
                  className={inputClass}
                  value={endsAt}
                  step={900}
                  disabled={!writable}
                  required
                  aria-invalid={startsAt !== '' && endsAt !== '' && !slotValid}
                  onChange={(event) => setEndsAt(event.target.value)}
                />
              )}
            </Field>
          </div>
          {startsAt !== '' && endsAt !== '' && !slotValid ? (
            <p className="text-sm text-danger">{t('operations.schedule.dialog.endBeforeStart')}</p>
          ) : null}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-content">
              {t('operations.schedule.dialog.people')}
            </legend>
            <ul className="grid gap-1 sm:grid-cols-2">
              {listed.map((person) => (
                <li key={person.id}>
                  <label className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-muted">
                    <input
                      type="checkbox"
                      checked={chosen.includes(person.id)}
                      disabled={!writable}
                      onChange={(event) =>
                        setChosen((current) =>
                          event.target.checked
                            ? [...current, person.id]
                            : current.filter((id) => id !== person.id),
                        )
                      }
                    />
                    <span
                      aria-hidden="true"
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: personColour(colourOf(person.id)) }}
                    />
                    <span dir="auto" className="text-content">
                      {person.name}
                    </span>
                    {crew.has(person.id) ? (
                      <span className="text-xs text-content-muted">
                        {t('operations.schedule.dialog.onCrew')}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            {writable && chosen.some((id) => !crew.has(id)) ? (
              <p className="text-xs text-content-muted">
                {t('operations.schedule.dialog.addedToCrew')}
              </p>
            ) : null}
          </fieldset>

          <Field label={t('operations.schedule.dialog.notes')}>
            {(id) => (
              <textarea
                id={id}
                className={inputClass}
                rows={3}
                maxLength={2000}
                value={notes}
                disabled={!writable}
                onChange={(event) => setNotes(event.target.value)}
              />
            )}
          </Field>

          {clashes.length > 0 || warnings.length > 0 ? (
            <ul className="flex flex-col gap-1 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-content">
              {clashes.map((clash) => (
                <li key={`${clash.userId}-${clash.conflictingVisitId}`}>
                  {t('operations.schedule.dialog.clash', {
                    name: nameOf(clash.userId),
                    reference: referenceOf(clash.conflictingWorkOrderId),
                  })}
                </li>
              ))}
              {warnings.map((warning) => (
                <li key={warning}>{t(`operations.schedule.warning.${warning}`)}</li>
              ))}
            </ul>
          ) : null}
        </form>
      )}

      {save.isError ? <Failure error={save.error} /> : null}
      {cancel.isError ? <Failure error={cancel.error} /> : null}
    </Dialog>
  );
}
