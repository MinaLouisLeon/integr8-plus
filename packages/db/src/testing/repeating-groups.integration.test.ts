import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Entries of a repeatable section in reports (migration 0014, P13b).
 *
 * A published version marks each field of a repeatable section with it; when a
 * submission is submitted, each entry's answers become typed rows of their own,
 * naming the entry — so a filter on "make" finds a submission whichever entry
 * the make was in, and a report can still tell the entries apart.
 */

const ENGINEER = '00000000-0000-4000-8000-00000000e811';

const gasSafety = {
  schemaVersion: 1,
  title: { en: 'Gas safety' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'property',
          fields: [{ id: 'address', type: 'text', label: { en: 'Address' } }],
        },
        {
          id: 'appliances',
          repeat: { maxEntries: 10, entryLabel: { en: 'Appliance' }, titleField: 'make' },
          fields: [
            { id: 'make', type: 'text', label: { en: 'Make' } },
            { id: 'rating_kw', type: 'decimal', decimalPlaces: 1, label: { en: 'Rating' } },
            {
              id: 'faults',
              type: 'multi_select',
              label: { en: 'Faults' },
              options: ['flue', 'seal', 'pressure'].map((value) => ({
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
  address: '4 Mill Lane',
  appliances: [
    { id: 'a-boiler', values: { make: 'Worcester', rating_kw: '24.0', faults: ['flue', 'seal'] } },
    { id: 'a-fire', values: { make: 'Baxi', notes: 'Chimney swept last spring' } },
  ],
};

let northwind: TenantFixture;
let owner: pg.Client;
let formId: string;
let versionId: string;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  owner = await connectAsOwner();
  ({ formId, versionId } = await withTenant(northwind.id, async (tx) => {
    const form = await tx.forms.createForm({ title: 'Gas safety', createdBy: ENGINEER });
    const draft = await tx.forms.createDraft({
      formId: form.id,
      definition: gasSafety,
      createdBy: ENGINEER,
    });
    const version = await tx.forms.publishDraft(draft.id, ENGINEER);
    return { formId: form.id, versionId: version!.id };
  }));
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

async function submit(values: Record<string, unknown>) {
  return withTenant(northwind.id, async (tx) => {
    const started = await tx.submissions.startDraft({
      formVersionId: versionId,
      submittedBy: ENGINEER,
      answers: values,
    });
    const result = await tx.submissions.submit(started.id, values, started.revision, ENGINEER);
    if (result.outcome !== 'written') {
      throw new Error(`setup: ${result.outcome}`);
    }
    return result.submission;
  });
}

describe('reporting entries', () => {
  it('marks each field of a repeatable section with it when the version is published', async () => {
    const version = await withTenant(northwind.id, (tx) => tx.forms.findVersion(versionId));
    expect(version?.reportableFields).toEqual([
      { field: 'address', type: 'text', multiple: false },
      { field: 'make', type: 'text', multiple: false, section: 'appliances' },
      { field: 'rating_kw', type: 'number', multiple: false, section: 'appliances' },
      { field: 'faults', type: 'text', multiple: true, section: 'appliances' },
    ]);
  });

  it('writes each entry’s answers as rows naming the entry and its place', async () => {
    const done = await submit(answers);
    const rows = await owner.query<Record<string, unknown>>(
      `select field_id, entry_id, entry_index, ordinal, value_text, value_number::text as value_number
         from submission_values where submission_id = $1
        order by entry_index, field_id, ordinal`,
      [done.id],
    );
    expect(rows.rows).toEqual([
      {
        field_id: 'address',
        entry_id: null,
        entry_index: 0,
        ordinal: 0,
        value_text: '4 Mill Lane',
        value_number: null,
      },
      {
        field_id: 'faults',
        entry_id: 'a-boiler',
        entry_index: 0,
        ordinal: 0,
        value_text: 'flue',
        value_number: null,
      },
      {
        field_id: 'faults',
        entry_id: 'a-boiler',
        entry_index: 0,
        ordinal: 1,
        value_text: 'seal',
        value_number: null,
      },
      {
        field_id: 'make',
        entry_id: 'a-boiler',
        entry_index: 0,
        ordinal: 0,
        value_text: 'Worcester',
        value_number: null,
      },
      {
        field_id: 'rating_kw',
        entry_id: 'a-boiler',
        entry_index: 0,
        ordinal: 0,
        value_text: null,
        value_number: '24.0',
      },
      {
        field_id: 'make',
        entry_id: 'a-fire',
        entry_index: 1,
        ordinal: 0,
        value_text: 'Baxi',
        value_number: null,
      },
    ]);
  });

  it('finds a submission by an answer in any of its entries, and by text written inside one', async () => {
    const worcester = await submit(answers);
    const other = await submit({
      appliances: [{ id: 'only', values: { make: 'Vaillant', faults: ['pressure'] } }],
    });
    const find = (query: Record<string, unknown>) =>
      withTenant(northwind.id, (tx) => tx.submissions.list({ formId, ...query }));

    const bySeal = await find({
      values: [{ field: 'faults', type: 'text', operator: 'eq', value: 'seal' }],
    });
    expect(bySeal.items.map((item) => item.id)).toContain(worcester.id);
    expect(bySeal.items.map((item) => item.id)).not.toContain(other.id);

    const byMake = await find({
      values: [{ field: 'make', type: 'text', operator: 'eq', value: 'Baxi' }],
    });
    expect(byMake.items.map((item) => item.id)).toContain(worcester.id);

    const bySweep = await find({ text: 'chimney' });
    expect(bySweep.items.map((item) => item.id)).toContain(worcester.id);
  });

  it('refuses an entry row that does not say which entry it is', async () => {
    const done = await submit(answers);
    await expect(
      owner.query(
        `insert into submission_values
           (tenant_id, submission_id, form_id, form_version_id, field_id, entry_id, entry_index,
            ordinal, value_type, value_text, submitted_at)
         values ($1, $2, $3, $4, 'make', null, 3, 0, 'text', 'Ideal', now())`,
        [northwind.id, done.id, formId, versionId],
      ),
    ).rejects.toThrow(/submission_values_entry_shape/u);
  });
});
