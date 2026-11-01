import { type CompiledForm, compileDefinition } from '@integr8/form-engine';
import { hasCarryOver, needsNewerApp, prefillAnswers } from '@integr8/form-input';
import {
  type AssetCarryOver,
  assetCarryOver,
  assetsEnabled,
  assetsOfJob,
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

/**
 * Whether the version a new submission of this form would be filled on is
 * written for a newer app than this one (schema version 2 and on). Such a form
 * is not started: the engineer is asked to update the app first, so no draft
 * is left on the job that this phone cannot open.
 */
export async function liveNeedsNewerApp(context: ChangeContext, form: JobForm): Promise<boolean> {
  const liveVersionId = form.liveVersionId;
  if (liveVersionId === null) {
    return false;
  }
  const live = await context.db.read((sql) =>
    sql.get<{ definition: string }>('select definition from form_versions where id = ?', [
      liveVersionId,
    ]),
  );
  return live !== undefined && needsNewerApp(JSON.parse(live.definition) as unknown);
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

/** A form started for one of the job's assets (CRM/ERP plan, phase E3; ADR-0008). */
export interface AssetStart {
  assetId: string;
  /** Its number, or its name while it has none. */
  label: string;
  /** What the form carries over from the asset's last visit, if anything. */
  carry: AssetCarryOver | undefined;
}

/** Whether this job's form, as the phone holds it, marks questions to carry over. */
export async function carriesOver(context: ChangeContext, form: JobForm): Promise<boolean> {
  const liveVersionId = form.liveVersionId;
  if (liveVersionId === null) {
    return false;
  }
  const live = await context.db.read((sql) =>
    sql.get<{ definition: string }>('select definition from form_versions where id = ?', [
      liveVersionId,
    ]),
  );
  const compiled =
    live === undefined
      ? undefined
      : compiledVersion(liveVersionId, JSON.parse(live.definition) as unknown);
  return compiled !== undefined && hasCarryOver(compiled);
}

/** Starting a form for this asset: what it would carry over, from the phone's copy. */
export async function assetStart(
  context: ChangeContext,
  input: { form: JobForm; workOrderId: string; assetId: string },
): Promise<AssetStart | undefined> {
  const { form, workOrderId, assetId } = input;
  const liveVersionId = form.liveVersionId;
  if (liveVersionId === null) {
    return undefined;
  }
  return context.db.read(async (sql) => {
    const asset = (await assetsOfJob(sql, workOrderId)).find(
      (candidate) => candidate.data.asset.id === assetId,
    );
    if (asset === undefined || asset.data.asset.status === 'retired') {
      return undefined;
    }
    return {
      assetId,
      label: asset.data.asset.reference === '' ? asset.data.asset.name : asset.data.asset.reference,
      carry: await assetCarryOver(sql, {
        assetId,
        formId: form.formId,
        formVersionId: liveVersionId,
      }),
    };
  });
}

/**
 * The asset a job's form is filled for when it is opened from the job: the
 * job's one asset in use, or none; `several` when the engineer must choose it
 * from the asset's own screen.
 */
export async function jobAsset(
  context: ChangeContext,
  input: { form: JobForm; workOrderId: string },
): Promise<AssetStart | 'several' | undefined> {
  const { form, workOrderId } = input;
  const assets = await context.db.read(async (sql) =>
    (await assetsEnabled(sql))
      ? (await assetsOfJob(sql, workOrderId)).filter(
          (asset) => asset.data.asset.status !== 'retired',
        )
      : [],
  );
  if (assets.length === 0) {
    return undefined;
  }
  if (assets.length > 1) {
    return 'several';
  }
  return assetStart(context, { form, workOrderId, assetId: assets[0]!.data.asset.id });
}

/** Starts a job's form on the phone, optionally from earlier answers or for an asset. Returns its id. */
export async function startForm(
  context: ChangeContext,
  input: {
    form: JobForm;
    workOrderId: string;
    startFrom: EarlierOffer | undefined;
    asset?: AssetStart | undefined;
  },
): Promise<string> {
  const { form, workOrderId, startFrom, asset } = input;
  if (form.liveVersionId === null) {
    throw new Error('This form has no published version on this phone.');
  }
  const carry = asset?.carry;
  const { submissionId } = await recordFormStarted(context, {
    formId: form.formId,
    formVersionId: form.liveVersionId,
    workOrderId,
    ...(asset === undefined ? {} : { assetId: asset.assetId }),
    ...(carry === undefined
      ? {}
      : { carriedOver: { fromSubmissionId: carry.fromSubmissionId, fields: carry.fields } }),
  });
  // The asset's carried-over answers take the place of the site's earlier ones.
  const answers = carry?.answers ?? startFrom?.answers;
  if (answers !== undefined) {
    await recordAnswers(context, { submissionId, answers });
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
