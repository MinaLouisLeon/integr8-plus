import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { SubmissionQuery } from '../repositories/submissions.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * P08's third exit criterion: filtering ten thousand submissions by a reportable
 * field returns in under 300 ms.
 *
 * The submissions go in through the same triggers production uses — every one
 * writes its history and its typed values — and a neighbouring company holds
 * the same number, so the indexes are doing the work rather than a table that
 * happens to contain only the rows asked for.
 *
 * Timed through the repository, so the measurement includes building the query,
 * the round trip and mapping the rows: what the API pays.
 */

const PER_COMPANY = 10_000;
const BUDGET_MS = 300;
const ENGINEER = '00000000-0000-4000-8000-00000000e901';

const definition = {
  schemaVersion: 1,
  title: { en: 'Service' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'site', type: 'text', label: { en: 'Site' } },
            { id: 'pressure', type: 'decimal', decimalPlaces: 2, label: { en: 'Pressure' } },
            { id: 'serviced_on', type: 'date', label: { en: 'Serviced on' } },
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result' },
              options: [
                { value: 'pass', label: { en: 'Pass' } },
                { value: 'fail', label: { en: 'Fail' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

let owner: pg.Client;
let northwind: TenantFixture;
let formId: string;

async function seed(tenant: TenantFixture): Promise<string> {
  const { form, version } = await withTenant(tenant.id, async (tx) => {
    const created = await tx.forms.createForm({ title: 'Service', createdBy: ENGINEER });
    const draft = await tx.forms.createDraft({
      formId: created.id,
      definition,
      createdBy: ENGINEER,
    });
    return { form: created, version: (await tx.forms.publishDraft(draft.id, ENGINEER))! };
  });

  // One statement, so the triggers run per row exactly as they would for ten
  // thousand separate submits. One in ten fails; pressure spreads over 0–9.99.
  await owner.query(
    `insert into submissions (tenant_id, form_id, form_version_id, status, answers, submitted_by, last_actor)
     select $1, $2, $3, 'submitted',
            jsonb_build_object(
              'site', 'Site ' || i,
              'pressure', to_char((i % 1000) / 100.0, 'FM0.00'),
              'serviced_on', to_char(date '2026-01-01' + (i % 250), 'YYYY-MM-DD'),
              'result', case when i % 10 = 0 then 'fail' else 'pass' end
            ),
            $4, $4
       from generate_series(1, $5) as i`,
    [tenant.id, form.id, version.id, ENGINEER, PER_COMPANY],
  );
  return form.id;
}

async function timed(query: SubmissionQuery) {
  // Warm once, then take the median of five: the claim is about steady state,
  // not the first query after a cold cache.
  await withTenant(northwind.id, (tx) => tx.submissions.list({ formId, ...query }));
  const durations: number[] = [];
  let count = 0;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    const page = await withTenant(northwind.id, (tx) => tx.submissions.list({ formId, ...query }));
    durations.push(performance.now() - started);
    count = page.items.length;
  }
  durations.sort((a, b) => a - b);
  return { median: durations[2]!, count };
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('northwind');
  const contoso = await createTenant('contoso');
  formId = await seed(northwind);
  await seed(contoso);
  await owner.query('analyze submissions, submission_values, submission_events');
}, 300_000);

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe(`filtering ${String(PER_COMPANY)} submissions by a reportable field`, () => {
  it('has them all, with their values, in each company', async () => {
    const counts = await owner.query<{ submissions: string; values: string; events: string }>(
      `select (select count(*) from submissions where tenant_id = $1) as submissions,
              (select count(*) from submission_values where tenant_id = $1) as values,
              (select count(*) from submission_events where tenant_id = $1) as events`,
      [northwind.id],
    );
    expect(counts.rows[0]).toEqual({
      submissions: String(PER_COMPANY),
      values: String(PER_COMPANY * 4),
      events: String(PER_COMPANY),
    });
  });

  it.each<[string, SubmissionQuery, number]>([
    [
      'a choice',
      { values: [{ field: 'result', type: 'text', operator: 'eq', value: 'fail' }] },
      50,
    ],
    [
      'a number range',
      { values: [{ field: 'pressure', type: 'number', operator: 'gte', value: '9.5' }] },
      50,
    ],
    [
      'a date',
      { values: [{ field: 'serviced_on', type: 'date', operator: 'eq', value: '2026-03-01' }] },
      40,
    ],
    [
      'two fields at once',
      {
        values: [
          { field: 'result', type: 'text', operator: 'eq', value: 'fail' },
          { field: 'pressure', type: 'number', operator: 'lt', value: '1' },
        ],
      },
      // 100 match; the first page holds 50.
      50,
    ],
    [
      'a rare value',
      { values: [{ field: 'site', type: 'text', operator: 'eq', value: 'Site 7777' }] },
      1,
    ],
  ])('by %s in under 300 ms', async (_label, query, expected) => {
    const { median, count } = await timed(query);
    expect(count).toBe(expected);
    expect(median, `median ${median.toFixed(1)} ms`).toBeLessThan(BUDGET_MS);
  });

  it('pages deep into the results as fast as the first page', async () => {
    let after: SubmissionQuery['after'];
    for (let page = 0; page < 10; page += 1) {
      const result = await withTenant(northwind.id, (tx) =>
        tx.submissions.list({
          formId,
          values: [{ field: 'result', type: 'text', operator: 'eq', value: 'pass' }],
          limit: 100,
          ...(after === undefined ? {} : { after }),
        }),
      );
      after = result.next;
    }
    const { median, count } = await timed({
      values: [{ field: 'result', type: 'text', operator: 'eq', value: 'pass' }],
      limit: 100,
      ...(after === undefined ? {} : { after }),
    });
    expect(count).toBe(100);
    expect(median).toBeLessThan(BUDGET_MS);
  });
});
