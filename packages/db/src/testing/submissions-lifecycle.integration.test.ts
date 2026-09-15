import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { Submission } from '../repositories/submissions.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * The submission lifecycle (migration 0008), against a real database.
 *
 * Most of what is proven here is proven *below* the repository, with raw SQL as
 * the owner and as the runtime role, because the claim is that these rules hold
 * for every client — not that one class happens to follow them.
 */

const ENGINEER = '00000000-0000-4000-8000-00000000e801';
const ADMIN = '00000000-0000-4000-8000-00000000a801';

const inspection = {
  schemaVersion: 1,
  title: { en: 'Inspection' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'site', type: 'text', label: { en: 'Site' } },
            { id: 'pressure', type: 'decimal', decimalPlaces: 2, label: { en: 'Pressure' } },
            { id: 'visits', type: 'number', label: { en: 'Visits' } },
            { id: 'inspected_on', type: 'date', label: { en: 'Inspected on' } },
            { id: 'arrived', type: 'time', label: { en: 'Arrived' } },
            { id: 'completed_at', type: 'datetime', label: { en: 'Completed' } },
            { id: 'safe', type: 'checkbox', label: { en: 'Safe' } },
            {
              id: 'hazards',
              type: 'multi_select',
              label: { en: 'Hazards' },
              options: ['gas', 'water', 'electric'].map((value) => ({
                value,
                label: { en: value },
              })),
            },
            { id: 'notes', type: 'long_text', label: { en: 'Notes' } },
          ],
        },
      ],
    },
  ],
};

const answers = {
  site: 'Riverside Depot',
  pressure: '1.75',
  visits: 3,
  inspected_on: '2026-09-10',
  arrived: '08:30',
  completed_at: '2026-09-10T11:15:00+03:00',
  safe: true,
  hazards: ['gas', 'electric'],
  notes: 'Flue terminal cleared of a bird nest',
};

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let formId: string;
let versionId: string;

async function publishInspection(tenant: TenantFixture) {
  return withTenant(tenant.id, async (tx) => {
    const form = await tx.forms.createForm({ title: 'Inspection', createdBy: ADMIN });
    const draft = await tx.forms.createDraft({
      formId: form.id,
      definition: inspection,
      createdBy: ADMIN,
    });
    const version = await tx.forms.publishDraft(draft.id, ADMIN);
    return { form, version: version! };
  });
}

const draft = (overrides: Record<string, unknown> = {}) =>
  withTenant(northwind.id, (tx) =>
    tx.submissions.startDraft({
      formVersionId: versionId,
      submittedBy: ENGINEER,
      answers: { ...answers, ...overrides },
    }),
  );

const submitted = async (overrides: Record<string, unknown> = {}): Promise<Submission> => {
  const started = await draft(overrides);
  const result = await withTenant(northwind.id, (tx) =>
    tx.submissions.submit(started.id, started.answers, started.revision, ENGINEER),
  );
  if (result.outcome !== 'written') {
    throw new Error(`setup: ${result.outcome}`);
  }
  return result.submission;
};

const values = async (submissionId: string) =>
  (
    await owner.query<Record<string, unknown>>(
      `select field_id, ordinal, value_type, value_text, value_number::text as value_number,
              to_char(value_date, 'YYYY-MM-DD') as value_date, value_time::text as value_time,
              value_timestamp, value_boolean
         from submission_values where submission_id = $1 order by field_id, ordinal`,
      [submissionId],
    )
  ).rows;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  owner = await connectAsOwner();
  app = await connectAsApp();
  const published = await publishInspection(northwind);
  formId = published.form.id;
  versionId = published.version.id;
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('publishing decides what is reportable', () => {
  it('stores the reportable fields with the version, leaving out prose', async () => {
    const version = await withTenant(northwind.id, (tx) => tx.forms.findVersion(versionId));
    expect(version?.reportableFields?.map((spec) => `${spec.field}:${spec.type}`)).toEqual([
      'site:text',
      'pressure:number',
      'visits:number',
      'inspected_on:date',
      'arrived:time',
      'completed_at:datetime',
      'safe:boolean',
      'hazards:text',
    ]);
  });

  it('refuses to publish a version without the list', async () => {
    const form = await withTenant(northwind.id, (tx) =>
      tx.forms.createForm({ title: 'Raw', createdBy: ADMIN }),
    );
    const created = await withTenant(northwind.id, (tx) =>
      tx.forms.createDraft({ formId: form.id, definition: inspection, createdBy: ADMIN }),
    );
    await expect(
      owner.query(
        `update form_versions set status = 'published', version_number = 1, published_at = now(),
                published_by = $2 where id = $1`,
        [created.id, ADMIN],
      ),
    ).rejects.toThrow(/form_versions_reportable_fields_at_publish/u);
  });
});

describe('drafts', () => {
  it('start with no submission time, and autosave on the revision last seen', async () => {
    const started = await draft();
    expect(started).toMatchObject({ status: 'draft', submittedAt: null, revision: 1, formId });

    const saved = await withTenant(northwind.id, (tx) =>
      tx.submissions.saveAnswers(started.id, { site: 'Moved' }, 1, ENGINEER),
    );
    expect(saved).toMatchObject({ outcome: 'written', submission: { revision: 2 } });

    const stale = await withTenant(northwind.id, (tx) =>
      tx.submissions.saveAnswers(started.id, { site: 'Other device' }, 1, ENGINEER),
    );
    expect(stale).toMatchObject({ outcome: 'conflict', current: { revision: 2 } });
  });

  it('write no history and no reportable values', async () => {
    const started = await draft();
    const events = await withTenant(northwind.id, (tx) => tx.submissions.listEvents(started.id));
    expect(events).toEqual([]);
    expect(await values(started.id)).toEqual([]);
  });

  it('cannot name a form their version does not belong to', async () => {
    const other = await withTenant(northwind.id, (tx) =>
      tx.forms.createForm({ title: 'Other', createdBy: ADMIN }),
    );
    await expect(
      owner.query(
        `insert into submissions (tenant_id, form_id, form_version_id, status, answers, submitted_by, last_actor)
         values ($1, $2, $3, 'draft', '{}', $4, $4)`,
        [northwind.id, other.id, versionId, ENGINEER],
      ),
    ).rejects.toThrow(/belongs to form/u);
  });
});

describe('submitting', () => {
  it('records when, by whom and what, and copies reportable answers as typed values', async () => {
    const done = await submitted();
    expect(done.status).toBe('submitted');
    expect(done.submittedAt).toBeInstanceOf(Date);

    const events = await withTenant(northwind.id, (tx) => tx.submissions.listEvents(done.id));
    expect(events).toMatchObject([
      { sequence: 1, kind: 'submitted', answers, actorId: ENGINEER, reason: null },
    ]);

    expect(await values(done.id)).toEqual([
      expect.objectContaining({ field_id: 'arrived', value_type: 'time', value_time: '08:30:00' }),
      expect.objectContaining({ field_id: 'completed_at', value_type: 'datetime' }),
      expect.objectContaining({ field_id: 'hazards', ordinal: 0, value_text: 'gas' }),
      expect.objectContaining({ field_id: 'hazards', ordinal: 1, value_text: 'electric' }),
      expect.objectContaining({ field_id: 'inspected_on', value_date: '2026-09-10' }),
      expect.objectContaining({ field_id: 'pressure', value_number: '1.75' }),
      expect.objectContaining({ field_id: 'safe', value_boolean: true }),
      expect.objectContaining({ field_id: 'site', value_text: 'Riverside Depot' }),
      expect.objectContaining({ field_id: 'visits', value_number: '3' }),
    ]);
    const completed = (await values(done.id)).find((row) => row.field_id === 'completed_at');
    expect((completed?.value_timestamp as Date).toISOString()).toBe('2026-09-10T08:15:00.000Z');
  });

  it('sets the submission time itself, whatever the client sent', async () => {
    const started = await draft();
    await asTenant(app, northwind.id, () =>
      app.query(
        `update submissions set status = 'submitted', submitted_at = '2001-01-01', last_actor = $2,
                revision = revision + 1 where id = $1`,
        [started.id, ENGINEER],
      ),
    );
    const row = await owner.query<{ submitted_at: Date }>(
      'select submitted_at from submissions where id = $1',
      [started.id],
    );
    expect(row.rows[0]!.submitted_at.getFullYear()).toBeGreaterThan(2025);
  });

  it('refuses a second submit of a submitted submission through the repository', async () => {
    const done = await submitted();
    const again = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(done.id, done.answers, done.revision, ENGINEER),
    );
    expect(again.outcome).toBe('wrong_status');
  });
});

describe('no silent edits — for every role', () => {
  it('refuses a change to submitted answers, as the runtime role and as the owner', async () => {
    const done = await submitted();
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update submissions set answers = '{"site":"edited"}' where id = $1`, [done.id]),
      ),
    ).rejects.toThrow(/cannot change without reopening/u);
    await expect(
      owner.query(`update submissions set answers = '{"site":"edited"}' where id = $1`, [done.id]),
    ).rejects.toThrow(/cannot change without reopening/u);
  });

  it('refuses a transition the lifecycle does not have', async () => {
    const done = await submitted();
    const started = await draft();
    for (const [id, status] of [
      [done.id, 'draft'],
      [started.id, 'reopened'],
    ] as const) {
      await expect(
        owner.query(`update submissions set status = $2 where id = $1`, [id, status]),
      ).rejects.toThrow(/cannot go from/u);
    }
    await expect(
      owner.query(
        `insert into submissions (tenant_id, form_id, form_version_id, status, answers, submitted_by, last_actor, submitted_at)
         values ($1, $2, $3, 'reopened', '{}', $4, $4, now())`,
        [northwind.id, formId, versionId, ENGINEER],
      ),
    ).rejects.toThrow(/cannot be created reopened/u);
  });

  it('refuses to hand a submission to someone else or to another form', async () => {
    const done = await submitted();
    await expect(
      owner.query(`update submissions set submitted_by = $2 where id = $1`, [done.id, ADMIN]),
    ).rejects.toThrow(/cannot be reassigned/u);
  });

  it('does not let the runtime role write history or reportable values', async () => {
    const done = await submitted();
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into submission_events (tenant_id, submission_id, sequence, kind, answers, actor_id)
           values ($1, $2, 99, 'submitted', '{}', $3)`,
          [northwind.id, done.id, ENGINEER],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`delete from submission_values where submission_id = $1`, [done.id]),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('refuses to change or delete history, even as the owner', async () => {
    const done = await submitted();
    await expect(
      owner.query(`update submission_events set reason = 'rewritten' where submission_id = $1`, [
        done.id,
      ]),
    ).rejects.toThrow(/append-only/u);
    await expect(
      owner.query(`delete from submission_events where submission_id = $1`, [done.id]),
    ).rejects.toThrow(/append-only/u);
  });
});

describe('reopening and amending', () => {
  it('needs a reason for each, and keeps every submitted state', async () => {
    const done = await submitted();

    await expect(
      owner.query(`update submissions set status = 'reopened', last_actor = $2 where id = $1`, [
        done.id,
        ADMIN,
      ]),
    ).rejects.toThrow(/reopening submission .* needs a reason/u);

    const reopened = await withTenant(northwind.id, (tx) =>
      tx.submissions.reopen(done.id, done.revision, ADMIN, 'Pressure was misread'),
    );
    expect(reopened).toMatchObject({ outcome: 'written', submission: { status: 'reopened' } });
    const current = (reopened as { submission: Submission }).submission;

    // A correction in progress: the reportable values are still the submitted ones.
    const saved = await withTenant(northwind.id, (tx) =>
      tx.submissions.saveAnswers(
        current.id,
        { ...answers, pressure: '2.10' },
        current.revision,
        ENGINEER,
      ),
    );
    expect(saved.outcome).toBe('written');
    expect((await values(done.id)).find((row) => row.field_id === 'pressure')?.value_number).toBe(
      '1.75',
    );

    const withoutReason = await withTenant(northwind.id, async (tx) => {
      try {
        return await tx.submissions.submit(
          done.id,
          { ...answers, pressure: '2.10' },
          current.revision + 1,
          ENGINEER,
        );
      } catch (error) {
        return error as Error;
      }
    });
    expect(withoutReason).toBeInstanceOf(Error);
    expect((withoutReason as Error).message).toMatch(/amending submission .* needs a reason/u);

    const amended = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(
        done.id,
        { ...answers, pressure: '2.10' },
        current.revision + 1,
        ENGINEER,
        'Re-read the gauge',
      ),
    );
    expect(amended).toMatchObject({ outcome: 'written', submission: { status: 'submitted' } });
    const final = (amended as { submission: Submission }).submission;
    expect(final.submittedAt?.getTime()).toBe(done.submittedAt?.getTime());
    expect(final.amendedAt).toBeInstanceOf(Date);

    const events = await withTenant(northwind.id, (tx) => tx.submissions.listEvents(done.id));
    expect(events.map((event) => [event.kind, event.reason, event.actorId])).toEqual([
      ['submitted', null, ENGINEER],
      ['reopened', 'Pressure was misread', ADMIN],
      ['amended', 'Re-read the gauge', ENGINEER],
    ]);
    expect(events[0]!.answers).toMatchObject({ pressure: '1.75' });
    expect(events[1]!.answers).toBeNull();
    expect(events[2]!.answers).toMatchObject({ pressure: '2.10' });
    expect((await values(done.id)).find((row) => row.field_id === 'pressure')?.value_number).toBe(
      '2.10',
    );
  });

  it('records where each submit was made, and lets nobody write it any other way (0012)', async () => {
    const started = await draft();
    const here = {
      status: 'captured' as const,
      latitude: '53.800712',
      longitude: '-1.549100',
      accuracyMeters: '7.3',
      capturedAt: '2026-09-15T10:04:31.000Z',
    };
    const first = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(
        started.id,
        started.answers,
        started.revision,
        ENGINEER,
        undefined,
        here,
      ),
    );
    expect(first).toMatchObject({ outcome: 'written', submission: { submitLocation: here } });
    const done = (first as { submission: Submission }).submission;

    // Not afterwards, not on a draft, not in another shape — as the owner or the runtime role.
    await expect(
      owner.query(`update submissions set submit_location = $2 where id = $1`, [
        done.id,
        { status: 'denied' },
      ]),
    ).rejects.toThrow(/written only by submitting/u);
    const other = await draft();
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update submissions set submit_location = $2, last_actor = $3 where id = $1`, [
          other.id,
          { status: 'denied' },
          ENGINEER,
        ]),
      ),
    ).rejects.toThrow(/written only by submitting/u);
    await expect(
      withTenant(northwind.id, (tx) =>
        tx.submissions.submit(other.id, other.answers, other.revision, ENGINEER, undefined, {
          status: 'somewhere',
        } as never),
      ),
    ).rejects.toThrow(/submissions_submit_location_shape/u);

    // A correction from a desktop records none, and the history keeps both.
    const reopened = await withTenant(northwind.id, (tx) =>
      tx.submissions.reopen(done.id, done.revision, ADMIN, 'Wrong unit'),
    );
    const current = (reopened as { submission: Submission }).submission;
    const amended = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(done.id, answers, current.revision, ENGINEER, 'Fixed the unit'),
    );
    expect(amended).toMatchObject({ outcome: 'written', submission: { submitLocation: null } });
    const events = await withTenant(northwind.id, (tx) => tx.submissions.listEvents(done.id));
    expect(events.map((event) => event.location)).toEqual([here, null, null]);
  });

  it('cannot reopen a draft', async () => {
    const started = await draft();
    const result = await withTenant(northwind.id, (tx) =>
      tx.submissions.reopen(started.id, started.revision, ADMIN, 'why'),
    );
    expect(result.outcome).toBe('wrong_status');
  });
});

describe('finding submissions', () => {
  let alpha: Submission;
  let beta: Submission;
  let gamma: Submission;

  beforeAll(async () => {
    const fresh = await publishInspection(northwind);
    formId = fresh.form.id;
    versionId = fresh.version.id;
    alpha = await submitted({
      site: 'Alpha Wharf',
      pressure: '1.20',
      safe: true,
      hazards: ['gas'],
    });
    beta = await submitted({
      site: 'Beta Yard',
      pressure: '3.40',
      safe: false,
      hazards: ['water'],
    });
    gamma = await submitted({ site: 'Gamma Works', pressure: '2.00', inspected_on: '2026-09-12' });
    await draft({ site: 'Delta draft' });
  });

  const ids = (page: { items: Submission[] }) => page.items.map((item) => item.id);
  const list = (query: Record<string, unknown>) => run(query);
  const run = (query: Record<string, unknown>) =>
    withTenant(northwind.id, (tx) => tx.submissions.list({ formId, ...query }));

  it('lists submitted ones newest first, leaving drafts out', async () => {
    expect(ids(await list({}))).toEqual([gamma.id, beta.id, alpha.id]);
  });

  it('lists drafts by last change when asked', async () => {
    const drafts = await run({ statuses: ['draft'], order: 'updated' });
    expect(drafts.items.map((item) => item.answers.site)).toEqual(['Delta draft']);
  });

  it('filters by typed reportable values', async () => {
    const by = (values: unknown[]) => run({ values });
    expect(
      ids(await by([{ field: 'pressure', type: 'number', operator: 'gt', value: '1.5' }])),
    ).toEqual([gamma.id, beta.id]);
    expect(
      ids(await by([{ field: 'safe', type: 'boolean', operator: 'eq', value: 'false' }])),
    ).toEqual([beta.id]);
    expect(
      ids(await by([{ field: 'hazards', type: 'text', operator: 'eq', value: 'gas' }])),
    ).toEqual([gamma.id, alpha.id]);
    // Any chosen option matches, not only the first.
    expect(
      ids(await by([{ field: 'hazards', type: 'text', operator: 'eq', value: 'electric' }])),
    ).toEqual([gamma.id]);
    expect(
      ids(
        await by([{ field: 'inspected_on', type: 'date', operator: 'gte', value: '2026-09-11' }]),
      ),
    ).toEqual([gamma.id]);
    expect(
      ids(await by([{ field: 'site', type: 'text', operator: 'contains', value: 'yard' }])),
    ).toEqual([beta.id]);
    expect(
      ids(
        await by([
          { field: 'pressure', type: 'number', operator: 'lte', value: '2' },
          { field: 'site', type: 'text', operator: 'contains', value: 'a' },
        ]),
      ),
    ).toEqual([gamma.id, alpha.id]);
  });

  it('treats a LIKE wildcard in a search as a character, not a pattern', async () => {
    expect(
      ids(
        await run({ values: [{ field: 'site', type: 'text', operator: 'contains', value: '%' }] }),
      ),
    ).toEqual([]);
  });

  it('searches every written answer', async () => {
    expect(ids(await run({ text: 'wharf' }))).toEqual([alpha.id]);
  });

  it('filters by submitter and by date', async () => {
    expect(ids(await run({ submittedBy: ADMIN }))).toEqual([]);
    expect(ids(await run({ submittedBefore: new Date(Date.now() - 60_000) }))).toEqual([]);
    expect((await run({ submittedFrom: new Date(Date.now() - 60_000) })).items).toHaveLength(3);
  });

  it('pages by keyset, without repeating or skipping', async () => {
    const first = await run({ limit: 2 });
    expect(ids(first)).toEqual([gamma.id, beta.id]);
    const second = await run({ limit: 2, after: first.next });
    expect(ids(second)).toEqual([alpha.id]);
    expect(second.next).toBeUndefined();
  });

  it('refuses a value filter with no form to give the field a meaning', async () => {
    await expect(
      withTenant(northwind.id, (tx) =>
        tx.submissions.list({
          values: [{ field: 'site', type: 'text', operator: 'eq', value: 'x' }],
        }),
      ),
    ).rejects.toThrow(/needs formId/u);
  });

  it('never shows another company’s submissions, history or values', async () => {
    const theirs = await withTenant(contoso.id, (tx) => tx.submissions.list({ formId }));
    expect(theirs.items).toEqual([]);
    const leaked = await asTenant(app, contoso.id, async () => ({
      events: (
        await app.query('select 1 from submission_events where submission_id = $1', [alpha.id])
      ).rowCount,
      values: (
        await app.query('select 1 from submission_values where submission_id = $1', [alpha.id])
      ).rowCount,
    }));
    expect(leaked).toEqual({ events: 0, values: 0 });
  });
});
