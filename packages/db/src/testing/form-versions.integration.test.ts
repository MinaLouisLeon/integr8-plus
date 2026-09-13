import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { FormVersion } from '../repositories/forms.js';
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
 * P06's second exit criterion: a published form version is provably immutable,
 * and the proof is at the database level, not in application code.
 *
 * So almost every test here bypasses the repository and speaks raw SQL — as the
 * schema owner, who holds every privilege and whom RLS does not apply to, and
 * as the runtime role that every request uses. If the only thing standing
 * between a published version and an `update` were a TypeScript method, these
 * tests would be able to change one. They must not be able to.
 */

const ADMIN = '00000000-0000-4000-8000-00000000a101';

const definition = (title: string) => ({
  schemaVersion: 1,
  title: { en: title },
  pages: [
    {
      id: 'page_1',
      sections: [
        { id: 'section_1', fields: [{ id: 'result', type: 'yes_no', label: { en: 'Result' } }] },
      ],
    },
  ],
});

let northwind: TenantFixture;
let southgate: TenantFixture;
let owner: pg.Client;
let app: pg.Client;

let formId: string;
let published: FormVersion;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();

  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');
  owner = await connectAsOwner();
  app = await connectAsApp();

  const created = await withTenant(northwind.id, async (tx) => {
    const form = await tx.forms.createForm({ title: 'Boiler service', createdBy: ADMIN });
    const draft = await tx.forms.createDraft({
      formId: form.id,
      definition: definition('v1'),
      createdBy: ADMIN,
    });
    const version = await tx.forms.publishDraft(draft.id, ADMIN);
    return { form, version };
  });

  formId = created.form.id;
  if (created.version === undefined) {
    throw new Error('setup: the draft did not publish');
  }
  published = created.version;
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

const IMMUTABLE = /is published and immutable/u;

describe('the schema owner, who can do anything else', () => {
  it.each([
    [
      'its definition',
      `update form_versions set definition = '{"schemaVersion":1,"tampered":true}'::jsonb where id = $1`,
    ],
    [
      'its status, back to draft',
      `update form_versions set status = 'draft', version_number = null, published_at = null, published_by = null where id = $1`,
    ],
    ['its version number', `update form_versions set version_number = 99 where id = $1`],
    [
      'when it was published',
      `update form_versions set published_at = now() - interval '1 year' where id = $1`,
    ],
    [
      'nothing at all — a no-op update',
      `update form_versions set definition = definition where id = $1`,
    ],
  ])('cannot change %s', async (_what, statement) => {
    await expect(owner.query(statement, [published.id])).rejects.toThrow(IMMUTABLE);
  });

  it('cannot delete it', async () => {
    await expect(
      owner.query('delete from form_versions where id = $1', [published.id]),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('cannot truncate the table, which would bypass every row-level guard', async () => {
    await expect(owner.query('truncate table form_versions cascade')).rejects.toThrow(
      /cannot be truncated/u,
    );
  });

  it('sees it exactly as it was published after all of that', async () => {
    const row = await owner.query<{ status: string; version_number: number; definition: unknown }>(
      'select status, version_number, definition from form_versions where id = $1',
      [published.id],
    );
    expect(row.rows[0]).toEqual({
      status: 'published',
      version_number: 1,
      definition: definition('v1'),
    });
  });

  it('reports the refusal with a state error, not a permission error, so it is not mistaken for a grant problem', async () => {
    const error = await owner
      .query('delete from form_versions where id = $1', [published.id])
      .catch((caught: unknown) => caught);
    expect((error as { code?: string }).code).toBe('55000');
  });
});

describe('the runtime role every request uses', () => {
  it('cannot update a published version either', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `update form_versions set definition = '{"schemaVersion":1}'::jsonb where id = $1`,
          [published.id],
        ),
      ),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('holds no delete privilege on versions or forms at all — the third, independent control', async () => {
    const grants = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name::text, privilege_type::text from information_schema.role_table_grants
        where grantee = 'integr8_app' and table_name in ('forms', 'form_versions', 'submissions')
        order by table_name, privilege_type`,
    );
    const byTable = (table: string) =>
      grants.rows.filter((row) => row.table_name === table).map((row) => row.privilege_type);

    expect(byTable('forms')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(byTable('form_versions')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(byTable('submissions')).toEqual(['INSERT', 'SELECT', 'UPDATE']);

    await expect(
      asTenant(app, northwind.id, () =>
        app.query('delete from form_versions where id = $1', [published.id]),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('cannot see another company’s versions', async () => {
    const rows = await asTenant(
      app,
      southgate.id,
      async () => (await app.query('select id from form_versions')).rowCount,
    );
    expect(rows).toBe(0);
  });
});

describe('drafts, which are allowed to change', () => {
  it('can be edited until published, then never again', async () => {
    const outcome = await withTenant(northwind.id, async (tx) => {
      const draft = await tx.forms.createDraft({
        formId,
        definition: definition('v2 draft'),
        createdBy: ADMIN,
      });
      const edited = await tx.forms.updateDraft(draft.id, definition('v2'));
      const version = await tx.forms.publishDraft(draft.id, ADMIN);
      const editedAfter = await tx.forms.updateDraft(draft.id, definition('v2 changed later'));
      return { edited, version, editedAfter };
    });

    expect(outcome.edited?.definition).toEqual(definition('v2'));
    expect(outcome.version).toMatchObject({ status: 'published', versionNumber: 2 });
    // The repository will not even try; and the database would refuse if it did.
    expect(outcome.editedAfter).toBeUndefined();
  });

  it('numbers versions 1, 2, 3 in publish order, and lists the draft last', async () => {
    const versions = await withTenant(northwind.id, async (tx) => {
      await tx.forms.createDraft({ formId, definition: definition('v3 draft'), createdBy: ADMIN });
      return tx.forms.listVersions(formId);
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([2, 1, null]);

    const latest = await withTenant(northwind.id, (tx) => tx.forms.findLatestPublished(formId));
    expect(latest?.versionNumber).toBe(2);
  });

  it('allows only one draft per form at a time', async () => {
    // The previous test left a draft open.
    await expect(
      withTenant(northwind.id, (tx) =>
        tx.forms.createDraft({ formId, definition: definition('second draft'), createdBy: ADMIN }),
      ),
    ).rejects.toThrow(/form_versions_one_draft_per_form/u);
  });

  it('cannot publish the same draft twice', async () => {
    const result = await withTenant(northwind.id, async (tx) => {
      const [draft] = (await tx.forms.listVersions(formId)).filter(
        (version) => version.status === 'draft',
      );
      const first = await tx.forms.publishDraft(draft!.id, ADMIN);
      const second = await tx.forms.publishDraft(draft!.id, ADMIN);
      return { first, second };
    });
    expect(result.first?.versionNumber).toBe(3);
    expect(result.second).toBeUndefined();
  });
});

describe('what a version row may contain', () => {
  it('refuses a published version with no number, time or publisher', async () => {
    await expect(
      owner.query(
        `insert into form_versions (tenant_id, form_id, status, definition, definition_schema_version, created_by)
         values ($1, $2, 'published', '{"schemaVersion":1}'::jsonb, 1, $3)`,
        [northwind.id, formId, ADMIN],
      ),
    ).rejects.toThrow(/form_versions_publication_complete/u);
  });

  it('refuses a schema version column that disagrees with the definition', async () => {
    await expect(
      owner.query(
        `insert into form_versions (tenant_id, form_id, definition, definition_schema_version, created_by)
         values ($1, $2, '{"schemaVersion":2}'::jsonb, 1, $3)`,
        [northwind.id, formId, ADMIN],
      ),
    ).rejects.toThrow(/form_versions_schema_version_matches/u);
  });

  it('refuses a version of a form belonging to another company', async () => {
    await expect(
      owner.query(
        `insert into form_versions (tenant_id, form_id, definition, definition_schema_version, created_by)
         values ($1, $2, '{"schemaVersion":1}'::jsonb, 1, $3)`,
        [southgate.id, formId, ADMIN],
      ),
    ).rejects.toThrow(/form_versions_form_fk/u);
  });
});

describe('submissions, bound to a published version', () => {
  it('bind to a published version', async () => {
    const submission = await withTenant(northwind.id, (tx) =>
      tx.submissions.create({
        formVersionId: published.id,
        answers: { result: 'yes' },
        submittedBy: ADMIN,
      }),
    );
    expect(submission).toMatchObject({ formVersionId: published.id, answers: { result: 'yes' } });
  });

  it('refuse to bind to a draft', async () => {
    const draft = await withTenant(northwind.id, async (tx) => {
      const form = await tx.forms.createForm({ title: 'Unpublished', createdBy: ADMIN });
      return tx.forms.createDraft({
        formId: form.id,
        definition: definition('draft only'),
        createdBy: ADMIN,
      });
    });

    await expect(
      withTenant(northwind.id, (tx) =>
        tx.submissions.create({ formVersionId: draft.id, answers: {}, submittedBy: ADMIN }),
      ),
    ).rejects.toThrow(/is not published/u);
  });

  it('refuse to be moved to another version once made, even by the owner', async () => {
    const { submission, other } = await withTenant(northwind.id, async (tx) => ({
      submission: await tx.submissions.create({
        formVersionId: published.id,
        answers: { result: 'no' },
        submittedBy: ADMIN,
      }),
      other: await tx.forms.findLatestPublished(formId),
    }));

    await expect(
      owner.query('update submissions set form_version_id = $1 where id = $2', [
        other!.id,
        submission.id,
      ]),
    ).rejects.toThrow(/cannot be moved/u);
  });

  it('refuse to bind to another company’s version, even naming its id', async () => {
    // Refused twice over. The binding trigger runs first and finds no published
    // version with that id *in this company*; behind it, the composite foreign
    // key would refuse the row at the end of the statement anyway. That the key
    // carries `tenant_id` is asserted for every table by the schema-invariant
    // suite, so here it is enough that the insert cannot succeed.
    await expect(
      owner.query(
        `insert into submissions (tenant_id, form_version_id, answers, submitted_by)
         values ($1, $2, '{}'::jsonb, $3)`,
        [southgate.id, published.id, ADMIN],
      ),
    ).rejects.toThrow(/is not published/u);
  });

  it('keep the version they were bound to from being deleted, published or not', async () => {
    await expect(
      owner.query('delete from form_versions where id = $1', [published.id]),
    ).rejects.toThrow();
    const count = await owner.query('select 1 from submissions where form_version_id = $1', [
      published.id,
    ]);
    expect(count.rowCount).toBeGreaterThan(0);
  });
});
