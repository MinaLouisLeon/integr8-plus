import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
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
 * The file-use index (0068), against a real database.
 *
 * "Is this file used?" used to scan every submission and every history entry
 * of the company as text. The index answers it by key, kept by trigger from
 * every save. The claim proven here is that the two agree, on the shapes
 * answers really take (single photos, several photos, a signature, files in
 * a repeating group) through a submission's whole life: a draft saved and
 * changed, submitted, reopened and amended.
 */

const ENGINEER = '00000000-0000-4000-8000-00000000e681';
const ADMIN = '00000000-0000-4000-8000-00000000a681';

const definition = {
  schemaVersion: 1,
  title: { en: 'Service visit' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'notes', type: 'long_text', label: { en: 'Notes' } },
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
            { id: 'signature', type: 'signature', label: { en: 'Signature' } },
          ],
        },
      ],
    },
  ],
};

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let versionId: string;
let contosoVersionId: string;

const fileRef = (id: string) => ({ mediaId: id, contentType: 'image/jpeg', byteSize: 2048 });
const newId = () => crypto.randomUUID();

async function publish(tenant: TenantFixture) {
  return withTenant(tenant.id, async (tx) => {
    const form = await tx.forms.createForm({ title: 'Service visit', createdBy: ADMIN });
    const draft = await tx.forms.createDraft({ formId: form.id, definition, createdBy: ADMIN });
    return (await tx.forms.publishDraft(draft.id, ADMIN))!.id;
  });
}

/** The scan `isReferenced` ran before 0068, verbatim, as the owner. */
async function scanned(tenant: TenantFixture, fileId: string): Promise<boolean> {
  const { rows } = await owner.query<{ referenced: boolean }>(
    `select exists (select 1 from submissions
                     where tenant_id = $1 and strpos(answers::text, $2) > 0)
         or exists (select 1 from attachments
                     where tenant_id = $1 and file_id = $2::uuid and removed_at is null)
         or exists (select 1 from submission_events
                     where tenant_id = $1 and strpos(answers::text, $2) > 0) as referenced`,
    [tenant.id, fileId],
  );
  return rows[0]!.referenced;
}

const indexed = (tenant: TenantFixture, fileId: string) =>
  withTenant(tenant.id, (tx) => tx.files.isReferenced(fileId));

async function expectAgreement(tenant: TenantFixture, fileIds: readonly string[]) {
  const results = [];
  for (const fileId of fileIds) {
    results.push({
      fileId,
      scan: await scanned(tenant, fileId),
      index: await indexed(tenant, fileId),
    });
  }
  expect(results.filter((result) => result.scan !== result.index)).toEqual([]);
  return new Map(results.map((result) => [result.fileId, result.index]));
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  app = await connectAsApp();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  versionId = await publish(northwind);
  contosoVersionId = await publish(contoso);
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('the file-use index', () => {
  it('agrees with the old scan through a submission’s whole life', async () => {
    const [kept, dropped, signature, nested, later, unused] = [
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
      newId(),
    ];
    const all = [kept, dropped, signature, nested, later, unused];

    // A draft with two photos, a signature and files inside a repeating group.
    const started = await withTenant(northwind.id, (tx) =>
      tx.submissions.startDraft({
        formVersionId: versionId,
        submittedBy: ENGINEER,
        answers: {
          notes: 'Boiler serviced; flue checked',
          photos: [fileRef(kept), fileRef(dropped)],
          signature: fileRef(signature),
          rooms: [
            { id: newId(), values: { room: 'Plant room', evidence: [fileRef(nested)] } },
            { id: newId(), values: { room: 'Roof', evidence: [] } },
          ],
        },
      }),
    );
    let state = await expectAgreement(northwind, all);
    expect([...state.values()]).toEqual([true, true, true, true, false, false]);

    // The draft loses a photo before it is submitted: it no longer counts.
    const saved = await withTenant(northwind.id, (tx) =>
      tx.submissions.saveAnswers(
        started.id,
        { ...started.answers, photos: [fileRef(kept)] },
        started.revision,
        ENGINEER,
      ),
    );
    expect(saved.outcome).toBe('written');
    state = await expectAgreement(northwind, all);
    expect(state.get(dropped)).toBe(false);

    // Submitted, then reopened and amended without the signature and with a
    // new photo: the signature stays used, because the history names it.
    const current = saved.outcome === 'written' ? saved.submission : started;
    const submitted = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(current.id, current.answers, current.revision, ENGINEER),
    );
    expect(submitted.outcome).toBe('written');
    const afterSubmit = submitted.outcome === 'written' ? submitted.submission : current;
    const reopened = await withTenant(northwind.id, (tx) =>
      tx.submissions.reopen(afterSubmit.id, afterSubmit.revision, ADMIN, 'Wrong signature'),
    );
    const open = reopened.outcome === 'written' ? reopened.submission : afterSubmit;
    const { signature: _removed, ...withoutSignature } = open.answers;
    const amended = await withTenant(northwind.id, (tx) =>
      tx.submissions.submit(
        open.id,
        { ...withoutSignature, photos: [fileRef(kept), fileRef(later)] },
        open.revision,
        ADMIN,
        'Signature taken again on paper',
      ),
    );
    expect(amended.outcome).toBe('written');
    state = await expectAgreement(northwind, all);
    expect(state.get(signature)).toBe(true);
    expect(state.get(later)).toBe(true);
    expect(state.get(unused)).toBe(false);

    const sources = await owner.query<{ file_id: string; source: string }>(
      `select file_id, source from submission_file_uses
        where tenant_id = $1 and submission_id = $2 order by file_id, source`,
      [northwind.id, started.id],
    );
    expect(
      sources.rows.filter((row) => row.file_id === signature).map((row) => row.source),
    ).toEqual(['history']);
    expect(await withTenant(northwind.id, (tx) => tx.files.submissionsNaming(later))).toEqual([
      started.id,
    ]);
  });

  it('agrees for a submission made in one step, as a phone’s sync makes it', async () => {
    const [photo, other] = [newId(), newId()];
    await withTenant(northwind.id, (tx) =>
      tx.submissions.create({
        formVersionId: versionId,
        submittedBy: ENGINEER,
        answers: { photos: [fileRef(photo)], notes: 'Quick visit' },
      }),
    );
    const state = await expectAgreement(northwind, [photo, other]);
    expect([...state.values()]).toEqual([true, false]);
  });

  it('keeps each company’s uses to itself', async () => {
    const photo = newId();
    await withTenant(contoso.id, (tx) =>
      tx.submissions.create({
        formVersionId: contosoVersionId,
        submittedBy: ENGINEER,
        answers: { photos: [fileRef(photo)] },
      }),
    );
    expect(await indexed(contoso, photo)).toBe(true);
    expect(await indexed(northwind, photo)).toBe(false);
    expect(await expectAgreement(northwind, [photo])).toEqual(new Map([[photo, false]]));

    const visible = await asTenant(app, northwind.id, async () =>
      app.query('select count(*)::int as n from submission_file_uses where file_id = $1', [photo]),
    );
    expect(visible.rows[0]).toEqual({ n: 0 });
  });

  it('cannot be written by the runtime role', async () => {
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into submission_file_uses (tenant_id, file_id, submission_id, source)
           values ($1, $2, $3, 'answers')`,
          [northwind.id, newId(), newId()],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('is rebuilt by the migration from what is already stored', async () => {
    const photo = newId();
    const made = await withTenant(northwind.id, (tx) =>
      tx.submissions.create({
        formVersionId: versionId,
        submittedBy: ENGINEER,
        answers: { photos: [fileRef(photo)] },
      }),
    );
    // What the migration's backfill does, after the index is emptied.
    await owner.query('delete from submission_file_uses where submission_id = $1', [made.id]);
    expect(await indexed(northwind, photo)).toBe(false);
    await owner.query(
      `insert into submission_file_uses (tenant_id, file_id, submission_id, source)
       select s.tenant_id, f, s.id, 'answers' from submissions s
        cross join lateral submission_answer_file_ids(s.answers) as f where s.id = $1
       union
       select e.tenant_id, f, e.submission_id, 'history' from submission_events e
        cross join lateral submission_answer_file_ids(e.answers) as f where e.submission_id = $1
       on conflict do nothing`,
      [made.id],
    );
    expect(await expectAgreement(northwind, [photo])).toEqual(new Map([[photo, true]]));
  });
});
