import { QUALIFICATION_OVERRIDE_REASON_MAX } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { type ReactNode, useState } from 'react';
import { buttonClass, Dialog, Failure, Field, inputClass } from '../ui.js';
import { groupByRequirement, type HoldingProblem, type UnqualifiedDetail } from './model.js';

/**
 * Going ahead without a qualification a job needs (P26).
 *
 * Nothing is blocked for good: when nobody on a visit holds what the job
 * needs, the dispatcher sees who lacks what and gives a reason, which is kept
 * in the job's history. These pieces say it the same way everywhere — in the
 * visit dialog, after a drag on the calendar, and for a batch of visits.
 */

export interface GapGroup {
  qualificationTypeId: string;
  name: string;
  people: readonly { id: string; name: string; status: HoldingProblem }[];
}

/** A refusal's details as gap groups, naming people from what the screen knows. */
export function gapsFromDetails(
  details: readonly UnqualifiedDetail[],
  nameOf: (userId: string) => string,
): GapGroup[] {
  return groupByRequirement(details).map((group) => ({
    qualificationTypeId: group.qualificationTypeId,
    name: group.name,
    people: group.people.map((person) => ({
      id: person.userId,
      name: nameOf(person.userId),
      status: person.status,
    })),
  }));
}

/** Each requirement nobody meets, and why each person on the visit does not count. */
export function GapList({ gaps }: { gaps: readonly GapGroup[] }) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-2">
      {gaps.map((gap) => (
        <li key={gap.qualificationTypeId} className="flex flex-col gap-0.5">
          <span dir="auto" className="font-medium text-content">
            {t('operations.qualifications.gap.nobodyHolds', { qualification: gap.name })}
          </span>
          {gap.people.length === 0 ? null : (
            <ul className="list-disc ps-5 text-content-muted">
              {gap.people.map((person) => (
                <li key={person.id} dir="auto">
                  {t(`operations.qualifications.gap.${person.status}`, {
                    name: person.name === '' ? t('operations.qualifications.someone') : person.name,
                  })}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The reason for going ahead: required, kept with the job. */
export function OverrideReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field
      label={t('operations.qualifications.override.reason')}
      hint={t('operations.qualifications.override.reasonHint')}
    >
      {(id, describedBy) => (
        <textarea
          id={id}
          className={inputClass}
          rows={2}
          required
          maxLength={QUALIFICATION_OVERRIDE_REASON_MAX}
          aria-describedby={describedBy}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/**
 * Asks for the reason in a dialog of its own: after a drag on the calendar
 * (cancel puts the visit back) and for a batch of visits (one reason for all).
 */
export function UnqualifiedPrompt({
  intro,
  children,
  confirmLabel,
  cancelLabel,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  intro: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  pending: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const ready = reason.trim() !== '';
  return (
    <Dialog
      title={t('operations.qualifications.override.title')}
      onClose={onCancel}
      wide
      footer={
        <>
          <button type="button" className={buttonClass.secondary} onClick={onCancel}>
            {cancelLabel ?? t('operations.qualifications.override.cancel')}
          </button>
          <button
            type="button"
            className={buttonClass.primary}
            disabled={!ready || pending}
            aria-busy={pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel ?? t('operations.qualifications.override.confirm')}
          </button>
        </>
      }
    >
      <p className="text-content">{intro}</p>
      <div className="rounded-md border border-warning bg-warning-subtle px-3 py-2">{children}</div>
      <OverrideReasonField value={reason} onChange={setReason} />
      {error === undefined || error === null ? null : <Failure error={error} />}
    </Dialog>
  );
}
