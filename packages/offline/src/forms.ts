import type { WorkOrderDetail } from './api-types.js';
import type { SqlConnection } from './sql.js';

/**
 * Forms, as the phone fills them (P13): which forms a job needs and how far each
 * has got, everything a fill screen needs to open one offline, and the earlier
 * answers a new one can start from.
 *
 * The phone's own `submissions` table is the truth here, not the job as last
 * downloaded: a form started or submitted offline shows as such at once.
 */

export type LocalSubmissionStatus = 'draft' | 'submitted' | 'reopened';

export interface JobForm {
  formId: string;
  title: string;
  required: boolean;
  /** The version a new submission is filled on; null when the form has none live. */
  liveVersionId: string | null;
  /** This engineer's submission of it for this job, as the phone has it. */
  submission: {
    id: string;
    status: LocalSubmissionStatus;
    updatedAt: string;
    /** Whether the server has it as the phone shows it. */
    sent: boolean;
  } | null;
}

export async function jobForms(sql: SqlConnection, workOrderId: string): Promise<JobForm[]> {
  const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
    workOrderId,
  ]);
  if (row === undefined) {
    return [];
  }
  const detail = JSON.parse(row.data) as WorkOrderDetail;
  const local = await sql.all<{
    id: string;
    form_id: string;
    status: LocalSubmissionStatus;
    updated_at: string;
    live_version_id: string | null;
    unsent: number;
  }>(
    `select s.id, s.form_id, s.status, s.updated_at, f.live_version_id,
            (s.server_revision is null
             or exists (select 1 from outbox o where o.entity_id = s.id and o.state <> 'done')) as unsent
       from submissions s left join forms f on f.id = s.form_id
      where s.work_order_id = ?
      order by s.updated_at desc`,
    [workOrderId],
  );
  const live = new Map(
    (
      await sql.all<{ id: string; live_version_id: string | null }>(
        `select id, live_version_id from forms where id in (select value from json_each(?))`,
        [JSON.stringify(detail.forms.map((form) => form.formId))],
      )
    ).map((form) => [form.id, form.live_version_id]),
  );

  return detail.forms.map((form) => {
    const mine = local.find((submission) => submission.form_id === form.formId);
    return {
      formId: form.formId,
      title: form.title,
      required: form.required,
      liveVersionId: live.get(form.formId) ?? null,
      submission:
        mine === undefined
          ? form.submission === null
            ? null
            : {
                id: form.submission.id,
                status: form.submission.status,
                updatedAt: form.submission.submittedAt ?? '',
                sent: true,
              }
          : {
              id: mine.id,
              status: mine.status,
              updatedAt: mine.updated_at,
              sent: mine.unsent === 0,
            },
    };
  });
}

export interface FillSession {
  submission: {
    id: string;
    formId: string;
    formVersionId: string;
    workOrderId: string | null;
    status: LocalSubmissionStatus;
    answers: Record<string, unknown>;
    updatedAt: string;
  };
  formTitle: string;
  /** The version's definition, as published. Undefined when it is not on the phone. */
  definition: unknown;
  job: { id: string; referenceLabel: string; title: string; siteId: string } | null;
}

/** Everything a fill screen needs, from the phone alone. */
export async function fillSession(
  sql: SqlConnection,
  submissionId: string,
): Promise<FillSession | undefined> {
  const row = await sql.get<{
    id: string;
    form_id: string;
    form_version_id: string;
    work_order_id: string | null;
    status: LocalSubmissionStatus;
    answers: string;
    updated_at: string;
    title: string | null;
    definition: string | null;
    reference_label: string | null;
    job_title: string | null;
    site_id: string | null;
  }>(
    `select s.id, s.form_id, s.form_version_id, s.work_order_id, s.status, s.answers, s.updated_at,
            f.title, v.definition, w.reference_label, w.title as job_title, w.site_id
       from submissions s
       left join forms f on f.id = s.form_id
       left join form_versions v on v.id = s.form_version_id
       left join work_orders w on w.id = s.work_order_id
      where s.id = ?`,
    [submissionId],
  );
  if (row === undefined) {
    return undefined;
  }
  return {
    submission: {
      id: row.id,
      formId: row.form_id,
      formVersionId: row.form_version_id,
      workOrderId: row.work_order_id,
      status: row.status,
      answers: JSON.parse(row.answers) as Record<string, unknown>,
      updatedAt: row.updated_at,
    },
    formTitle: row.title ?? '',
    definition: row.definition === null ? undefined : (JSON.parse(row.definition) as unknown),
    job:
      row.work_order_id === null || row.reference_label === null
        ? null
        : {
            id: row.work_order_id,
            referenceLabel: row.reference_label,
            title: row.job_title ?? '',
            siteId: row.site_id ?? '',
          },
  };
}

export interface EarlierAnswers {
  submissionId: string;
  formVersionId: string;
  definition: unknown;
  answers: Record<string, unknown>;
  submittedAt: string | null;
  job: { id: string; referenceLabel: string };
}

/**
 * The most recent submitted answers to the same form at the same site, from the
 * jobs on this phone — what a new form can start from. Only forms whose version
 * is still on the phone count: answers cannot be moved to today's version without
 * knowing the questions they answered.
 */
export async function earlierAnswersAtSite(
  sql: SqlConnection,
  input: { formId: string; siteId: string; excludeSubmissionId: string },
): Promise<EarlierAnswers | undefined> {
  const row = await sql.get<{
    id: string;
    form_version_id: string;
    definition: string;
    answers: string;
    submitted_at: string | null;
    work_order_id: string;
    reference_label: string;
  }>(
    `select s.id, s.form_version_id, v.definition, s.answers, s.submitted_at, s.work_order_id, w.reference_label
       from submissions s
       join work_orders w on w.id = s.work_order_id
       join form_versions v on v.id = s.form_version_id
      where s.form_id = ? and w.site_id = ? and s.status = 'submitted' and s.id <> ?
      order by coalesce(s.submitted_at, s.updated_at) desc
      limit 1`,
    [input.formId, input.siteId, input.excludeSubmissionId],
  );
  return row === undefined
    ? undefined
    : {
        submissionId: row.id,
        formVersionId: row.form_version_id,
        definition: JSON.parse(row.definition) as unknown,
        answers: JSON.parse(row.answers) as Record<string, unknown>,
        submittedAt: row.submitted_at,
        job: { id: row.work_order_id, referenceLabel: row.reference_label },
      };
}

export interface LocalMedia {
  mediaId: string;
  /** Relative to the files directory. */
  localPath: string;
  thumbnailPath: string | null;
  contentType: string;
  byteSize: number;
  state: 'queued' | 'confirmed' | 'failed';
}

/** Files this phone captured, by id, for showing them in a form. */
export async function localMedia(
  sql: SqlConnection,
  mediaIds: readonly string[],
): Promise<Map<string, LocalMedia>> {
  if (mediaIds.length === 0) {
    return new Map();
  }
  const rows = await sql.all<{
    media_id: string;
    local_path: string;
    thumbnail_path: string | null;
    content_type: string;
    byte_size: number;
    state: LocalMedia['state'];
  }>(
    `select media_id, local_path, thumbnail_path, content_type, byte_size, state
       from uploads where media_id in (select value from json_each(?))`,
    [JSON.stringify(mediaIds)],
  );
  return new Map(
    rows.map((row) => [
      row.media_id,
      {
        mediaId: row.media_id,
        localPath: row.local_path,
        thumbnailPath: row.thumbnail_path,
        contentType: row.content_type,
        byteSize: row.byte_size,
        state: row.state,
      },
    ]),
  );
}
