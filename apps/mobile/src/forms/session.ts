import { type CompiledForm, compileDefinition } from '@integr8/form-engine';
import { prefillAnswers } from '@integr8/form-input';
import {
  type ChangeContext,
  earlierAnswersAtSite,
  type JobForm,
  recordAnswers,
  recordFormStarted,
  recordSubmit,
  type SubmitLocation,
} from '@integr8/offline';

/**
 * Starting, opening and submitting a form on the phone — all of it local. The
 * outbox takes it from there (P12): nothing here talks to the server.
 */

const compiled = new Map<string, CompiledForm | undefined>();

/**
 * A version's compiled form. A published version never changes, so it is
 * compiled once per launch; undefined when the definition does not compile,
 * which the server would never have published.
 */
export function compiledVersion(versionId: string, definition: unknown): CompiledForm | undefined {
  if (!compiled.has(versionId)) {
    const result = compileDefinition(definition);
    compiled.set(versionId, result.ok ? result.form : undefined);
  }
  return compiled.get(versionId);
}

/** Today in the engineer's calendar, `YYYY-MM-DD` — what "before today" rules are judged on. */
export function localToday(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface EarlierOffer {
  answers: Record<string, unknown>;
  filled: number;
  job: string;
  submittedAt: string | null;
}

/** Earlier answers a new form at this site could start from, if any carry over. */
export async function earlierOffer(
  context: ChangeContext,
  input: { form: JobForm; siteId: string },
): Promise<EarlierOffer | undefined> {
  const { form, siteId } = input;
  if (form.liveVersionId === null) {
    return undefined;
  }
  const liveVersionId = form.liveVersionId;
  const found = await context.db.read(async (sql) => ({
    earlier: await earlierAnswersAtSite(sql, {
      formId: form.formId,
      siteId,
      excludeSubmissionId: '',
    }),
    live: await sql.get<{ definition: string }>(
      'select definition from form_versions where id = ?',
      [liveVersionId],
    ),
  }));
  if (found.earlier === undefined || found.live === undefined) {
    return undefined;
  }
  const previous = compiledVersion(found.earlier.formVersionId, found.earlier.definition);
  const current = compiledVersion(liveVersionId, JSON.parse(found.live.definition) as unknown);
  if (previous === undefined || current === undefined) {
    return undefined;
  }
  const prefill = prefillAnswers(previous, current, found.earlier.answers);
  return prefill.filled.length === 0
    ? undefined
    : {
        answers: prefill.answers,
        filled: prefill.filled.length,
        job: found.earlier.job.referenceLabel,
        submittedAt: found.earlier.submittedAt,
      };
}

/** Starts a job's form on the phone, optionally from earlier answers. Returns its id. */
export async function startForm(
  context: ChangeContext,
  input: { form: JobForm; workOrderId: string; startFrom: EarlierOffer | undefined },
): Promise<string> {
  const { form, workOrderId, startFrom } = input;
  if (form.liveVersionId === null) {
    throw new Error('This form has no published version on this phone.');
  }
  const { submissionId } = await recordFormStarted(context, {
    formId: form.formId,
    formVersionId: form.liveVersionId,
    workOrderId,
  });
  if (startFrom !== undefined) {
    await recordAnswers(context, { submissionId, answers: startFrom.answers });
  }
  return submissionId;
}

export async function submitForm(
  context: ChangeContext,
  input: {
    submissionId: string;
    answers: Record<string, unknown>;
    today: string;
    reason: string | undefined;
    location: SubmitLocation;
  },
): Promise<void> {
  await recordSubmit(context, {
    submissionId: input.submissionId,
    answers: input.answers,
    filledOn: input.today,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    location: input.location,
  });
}
