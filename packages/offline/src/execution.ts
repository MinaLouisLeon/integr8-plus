import { type CompletionMissing, completionMissing, jobTimes, type JobTimes } from '@integr8/core';
import type { SubmitLocation, WorkOrderDetail } from './api-types.js';
import { jobForms } from './forms.js';
import type { SqlConnection } from './sql.js';

/**
 * The working day on the phone (P14): whether the engineer is clocked in, what a
 * job still needs before it can be completed, and how long it has taken — all
 * from the phone alone, in the same terms the server uses (`@integr8/core`).
 */

export interface LocalShift {
  id: string;
  startedAt: string;
  endedAt: string | null;
  startLocation: SubmitLocation | null;
  endLocation: SubmitLocation | null;
}

interface ShiftRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  start_location: string | null;
  end_location: string | null;
}

const toShift = (row: ShiftRow): LocalShift => ({
  id: row.id,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  startLocation:
    row.start_location === null ? null : (JSON.parse(row.start_location) as SubmitLocation),
  endLocation: row.end_location === null ? null : (JSON.parse(row.end_location) as SubmitLocation),
});

/** The shift the engineer is clocked in to, if any. */
export async function currentShift(sql: SqlConnection): Promise<LocalShift | undefined> {
  const row = await sql.get<ShiftRow>(
    'select * from shifts where ended_at is null order by started_at desc limit 1',
  );
  return row === undefined ? undefined : toShift(row);
}

/** Shifts started since a moment, newest first. */
export async function shiftsSince(sql: SqlConnection, since: Date): Promise<LocalShift[]> {
  return (
    await sql.all<ShiftRow>(
      'select * from shifts where started_at >= ? or ended_at is null order by started_at desc',
      [since.toISOString()],
    )
  ).map(toShift);
}

export interface LocalCompletion {
  missing: CompletionMissing;
  photos: { before: number; after: number };
}

/**
 * What stands between a job and completing it, as the phone has it: forms
 * submitted here count, photos taken here count, a sign-off given here counts,
 * though none of it may have reached the server yet.
 */
export async function localCompletion(
  sql: SqlConnection,
  workOrderId: string,
): Promise<LocalCompletion | undefined> {
  const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
    workOrderId,
  ]);
  if (row === undefined) {
    return undefined;
  }
  const detail = JSON.parse(row.data) as WorkOrderDetail;
  const forms = await jobForms(sql, workOrderId);
  const photos = {
    before: detail.attachments.filter((attachment) => attachment.stage === 'before').length,
    after: detail.attachments.filter((attachment) => attachment.stage === 'after').length,
  };
  return {
    photos,
    missing: completionMissing({
      forms: forms.map((form) => ({
        formId: form.formId,
        title: form.title,
        required: form.required,
        submitted: form.submission?.status === 'submitted',
      })),
      photos: {
        before: { needed: detail.execution.beforePhotos, taken: photos.before },
        after: { needed: detail.execution.afterPhotos, taken: photos.after },
      },
      signoff: {
        required: detail.execution.signatureRequired,
        recorded: detail.execution.signoff !== null,
      },
    }),
  };
}

/** Time spent on a job so far, from its history including changes still on the phone. */
export function timesOnJob(detail: WorkOrderDetail, now: Date): JobTimes {
  return jobTimes(
    detail.events.flatMap((event) =>
      event.kind === 'transitioned' && event.fromState !== null && event.toState !== null
        ? [{ fromState: event.fromState, toState: event.toState, occurredAt: event.occurredAt }]
        : [],
    ),
    now,
  );
}
