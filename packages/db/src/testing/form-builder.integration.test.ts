import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
import { syncFormTemplates } from '../seed/templates.js';
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
 * What the form builder stores (migration 0007), against a real database.
 *
 * Autosave that cannot overwrite another tab, a publish that records what it
 * changed and refuses a draft saved since it was reviewed, settings the
 * database refuses to get wrong, and a template library every company can read
 * and none can write.
 */

const ADMIN = '00000000-0000-4000-8000-00000000a101';

const definition = (label: string) => ({
  schemaVersion: 1,
  title: { en: label },
  pages: [
    {
      id: 'page_1',
      sections: [
        { id: 'section_1', fields: [{ id: 'result', type: 'yes_no', label: { en: label } }] },
      ],
    },
  ],
});

let northwind: TenantFixture;
let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  owner = await connectAsOwner();
  app = await connectAsApp();
  await owner.query('delete from form_templates');
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

const newForm = (title: string) =>
  withTenant(northwind.id, (tx) => tx.forms.createForm({ title, createdBy: ADMIN }));

describe('autosave', () => {
  it('creates the first draft, then saves over the revision it last saw', async () => {
    const form = await newForm('Autosave');

    const first = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('one'), null, ADMIN),
    );
    expect(first).toMatchObject({ outcome: 'saved', version: { revision: 1, status: 'draft' } });

    const second = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('two'), 1, ADMIN),
    );
    expect(second).toMatchObject({
      outcome: 'saved',
      version: { revision: 2, definition: definition('two') },
    });
  });

  it('refuses a save from a tab that is behind, and hands back what the other tab saved', async () => {
    const form = await newForm('Two tabs');
    await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('base'), null, ADMIN),
    );
    await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('tab A'), 1, ADMIN),
    );

    const tabB = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('tab B'), 1, ADMIN),
    );
    expect(tabB).toMatchObject({
      outcome: 'conflict',
      current: { revision: 2, definition: definition('tab A') },
    });

    const stored = await withTenant(northwind.id, (tx) => tx.forms.findDraft(form.id));
    expect(stored?.definition).toEqual(definition('tab A'));
  });

  it('treats a second "first draft" as a conflict, not a second draft', async () => {
    const form = await newForm('Race');
    const [one, two] = await Promise.all([
      withTenant(northwind.id, (tx) => tx.forms.saveDraft(form.id, definition('one'), null, ADMIN)),
      withTenant(northwind.id, (tx) => tx.forms.saveDraft(form.id, definition('two'), null, ADMIN)),
    ]);
    expect([one.outcome, two.outcome].sort()).toEqual(['conflict', 'saved']);

    const drafts = await owner.query(
      "select 1 from form_versions where form_id = $1 and status = 'draft'",
      [form.id],
    );
    expect(drafts.rowCount).toBe(1);
  });

  it('resolves a race for the first draft through the savepoint, leaving the loser usable', async () => {
    // Deterministic rather than hoping Promise.all interleaves: the first
    // transaction creates the draft and is held open, uncommitted. The second
    // cannot see it, passes the pre-check, and blocks on the unique draft index
    // until the first commits — then takes the savepoint path. If the savepoint
    // did not work, its next query would fail with "current transaction is
    // aborted".
    const form = await newForm('Savepoint');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstSaved!: () => void;
    const saved = new Promise<void>((resolve) => {
      firstSaved = resolve;
    });

    const first = withTenant(northwind.id, async (tx) => {
      const result = await tx.forms.saveDraft(form.id, definition('first'), null, ADMIN);
      firstSaved();
      await gate;
      return result.outcome;
    });
    await saved;

    const second = withTenant(northwind.id, async (tx) => {
      const result = await tx.forms.saveDraft(form.id, definition('second'), null, ADMIN);
      const title = (await tx.forms.findForm(form.id))?.title;
      return {
        outcome: result.outcome,
        current: result.outcome === 'conflict' ? result.current?.definition : undefined,
        title,
      };
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    release();

    expect(await first).toBe('saved');
    expect(await second).toEqual({
      outcome: 'conflict',
      current: definition('first'),
      title: 'Savepoint',
    });
  });
});

describe('publishing', () => {
  it('records the change note and the change summary on the version', async () => {
    const form = await newForm('Noted');
    const saved = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('v1'), null, ADMIN),
    );
    if (saved.outcome !== 'saved') throw new Error('setup');

    const published = await withTenant(northwind.id, (tx) =>
      tx.forms.publishDraft(saved.version.id, ADMIN, {
        changeNote: 'First release',
        changes: { changes: [{ kind: 'added', element: 'result' }], breaking: [] },
        expectedRevision: 1,
      }),
    );
    expect(published).toMatchObject({
      versionNumber: 1,
      changeNote: 'First release',
      changes: { breaking: [] },
    });
  });

  it('refuses to publish a draft saved since the publisher reviewed it', async () => {
    const form = await newForm('Reviewed');
    const saved = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('reviewed'), null, ADMIN),
    );
    if (saved.outcome !== 'saved') throw new Error('setup');
    await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('changed after review'), 1, ADMIN),
    );

    const refused = await withTenant(northwind.id, (tx) =>
      tx.forms.publishDraft(saved.version.id, ADMIN, { expectedRevision: 1 }),
    );
    expect(refused).toBeUndefined();
    expect((await withTenant(northwind.id, (tx) => tx.forms.findDraft(form.id)))?.status).toBe(
      'draft',
    );
  });

  it('does not let a note or summary be attached to a draft', async () => {
    const form = await newForm('No draft notes');
    const saved = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('d'), null, ADMIN),
    );
    if (saved.outcome !== 'saved') throw new Error('setup');
    await expect(
      owner.query("update form_versions set change_note = 'sneaky' where id = $1", [
        saved.version.id,
      ]),
    ).rejects.toThrow(/form_versions_history_only_when_published/u);
  });

  it('keeps a published note as immutable as the rest of the version', async () => {
    const form = await newForm('Frozen note');
    const saved = await withTenant(northwind.id, (tx) =>
      tx.forms.saveDraft(form.id, definition('d'), null, ADMIN),
    );
    if (saved.outcome !== 'saved') throw new Error('setup');
    await withTenant(northwind.id, (tx) =>
      tx.forms.publishDraft(saved.version.id, ADMIN, { changeNote: 'Original' }),
    );

    await expect(
      owner.query("update form_versions set change_note = 'Rewritten' where id = $1", [
        saved.version.id,
      ]),
    ).rejects.toThrow(/is published and immutable/u);
  });

  it('lists version summaries without their definitions', async () => {
    const summaries = await withTenant(northwind.id, (tx) => tx.forms.listVersionSummaries());
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every((summary) => !('definition' in summary))).toBe(true);
  });
});

describe('form settings', () => {
  it('defaults to every role filling, and no mandatory signature', async () => {
    const form = await newForm('Defaults');
    expect(form).toMatchObject({
      fillRoles: ['owner', 'admin', 'dispatcher', 'engineer', 'viewer'],
      signatureRequired: false,
      clonedFromFormId: null,
      sourceTemplateKey: null,
    });
  });

  it('updates who may fill and whether a signature is required', async () => {
    const form = await newForm('Settings');
    const updated = await withTenant(northwind.id, (tx) =>
      tx.forms.updateForm(form.id, {
        fillRoles: ['engineer', 'engineer', 'dispatcher'],
        signatureRequired: true,
        title: ' Renamed ',
      }),
    );
    expect(updated).toMatchObject({
      title: 'Renamed',
      fillRoles: ['engineer', 'dispatcher'],
      signatureRequired: true,
    });
    expect(await withTenant(northwind.id, (tx) => tx.forms.updateForm(form.id, {}))).toMatchObject({
      title: 'Renamed',
    });
    expect(
      await withTenant(northwind.id, (tx) =>
        tx.forms.updateForm('00000000-0000-4000-8000-000000000000', { title: 'x' }),
      ),
    ).toBeUndefined();
  });

  it('refuses a form nobody may fill, and a role that does not exist', async () => {
    const form = await newForm('Guarded');
    await expect(
      owner.query("update forms set fill_roles = '{}' where id = $1", [form.id]),
    ).rejects.toThrow(/forms_fill_roles_not_empty/u);
    await expect(
      owner.query("update forms set fill_roles = '{owner,superadmin}' where id = $1", [form.id]),
    ).rejects.toThrow(/forms_fill_roles_known/u);
  });

  it('records where a form came from, but not two places at once', async () => {
    const original = await newForm('Original');
    const clone = await withTenant(northwind.id, (tx) =>
      tx.forms.createForm({ title: 'Clone', createdBy: ADMIN, clonedFromFormId: original.id }),
    );
    expect(clone.clonedFromFormId).toBe(original.id);

    await expect(
      owner.query("update forms set source_template_key = 'boiler_service' where id = $1", [
        clone.id,
      ]),
    ).rejects.toThrow(/forms_single_source/u);
  });
});

describe('the global template library', () => {
  it('loads every template the engine ships, and loading again changes nothing', async () => {
    expect(await syncFormTemplates()).toBe(FORM_TEMPLATES.length);
    expect(await syncFormTemplates()).toBe(FORM_TEMPLATES.length);
    const count = await owner.query('select count(*)::int as n from form_templates');
    expect(count.rows[0]).toEqual({ n: FORM_TEMPLATES.length });
  });

  it('is readable from any company’s transaction', async () => {
    const templates = await withTenant(northwind.id, (tx) => tx.formTemplates.list());
    expect(templates.map((template) => template.key).sort()).toEqual(
      FORM_TEMPLATES.map((template) => template.key).sort(),
    );
    expect(
      await withTenant(northwind.id, (tx) => tx.formTemplates.find('boiler_service')),
    ).toMatchObject({ category: 'maintenance' });
    expect(await withTenant(northwind.id, (tx) => tx.formTemplates.find('nope'))).toBeUndefined();
  });

  it('cannot be changed by the runtime role, in any way', async () => {
    for (const statement of [
      'update form_templates set title = \'{"en":"x"}\'::jsonb',
      'delete from form_templates',
      "insert into form_templates (key, title, description, category, definition, definition_schema_version) values ('mine', '{}', '{}', 'safety', '{\"schemaVersion\":1}', 1)",
    ]) {
      await expect(
        asTenant(app, northwind.id, () => app.query(statement)),
        statement,
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('refuses a template whose schema version disagrees with its definition', async () => {
    await expect(
      getPlatformDataSource().formTemplates.upsert([
        {
          key: 'broken',
          title: { en: 'x' },
          description: { en: 'x' },
          category: 'safety',
          definition: { schemaVersion: 'one' },
        },
      ]),
    ).rejects.toThrow(/integer schemaVersion/u);
    expect(await getPlatformDataSource().formTemplates.upsert([])).toBe(0);
  });
});
