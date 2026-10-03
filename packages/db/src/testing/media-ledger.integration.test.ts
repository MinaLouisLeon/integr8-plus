import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
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
 * The media ledger (migration 0009), against a real database.
 *
 * The claims that matter for billing are proven below the repository: that the
 * runtime role cannot change what storage confirmed, cannot write the usage
 * rollup, and that the rollup follows every change to the ledger whoever makes
 * it.
 */

const ENGINEER = '00000000-0000-4000-8000-00000000e901';
const ADMIN = '00000000-0000-4000-8000-00000000a901';
const DAY = 24 * 60 * 60 * 1000;

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;

const bucketOf = (tenant: TenantFixture) => `local-${tenant.id}`;

async function intent(
  tenant: TenantFixture,
  overrides: { declaredBytes?: number; category?: 'image' | 'document'; expiresAt?: Date } = {},
) {
  const id = crypto.randomUUID();
  return withTenant(tenant.id, (tx) =>
    tx.files.createIntent({
      id,
      bucket: bucketOf(tenant),
      storageKey: `media/${id}`,
      contentType: overrides.category === 'document' ? 'application/pdf' : 'image/jpeg',
      declaredBytes: overrides.declaredBytes ?? 1000,
      category: overrides.category ?? 'image',
      createdBy: ENGINEER,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    }),
  );
}

async function stored(
  tenant: TenantFixture,
  byteSize: number,
  category: 'image' | 'document' = 'image',
) {
  const created = await intent(tenant, { declaredBytes: byteSize, category });
  const file = await withTenant(tenant.id, (tx) =>
    tx.files.confirm(created.id, {
      byteSize,
      etag: `"${created.id.slice(0, 8)}"`,
      contentType: created.contentType,
    }),
  );
  return file!;
}

const usage = (tenant: TenantFixture) => withTenant(tenant.id, (tx) => tx.files.usage());

const bytesOf = async (tenant: TenantFixture, category: string) =>
  (await usage(tenant)).categories.find((entry) => entry.category === category)!;

beforeAll(async () => {
  useTestDatabase();
  owner = await connectAsOwner();
  app = await connectAsApp();
});

beforeEach(async () => {
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  for (const tenant of [northwind, contoso]) {
    await getPlatformDataSource().storage.record({
      tenantId: tenant.id,
      provider: 'local',
      bucket: bucketOf(tenant),
    });
  }
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('confirming an upload', () => {
  it('writes the ledger from what storage reported, not what was declared, exactly once', async () => {
    const created = await intent(northwind, { declaredBytes: 5000 });
    expect(await usage(northwind)).toMatchObject({ totalBytes: 0, totalObjects: 0 });

    const file = await withTenant(northwind.id, (tx) =>
      tx.files.confirm(created.id, { byteSize: 4999, etag: '"abc"', contentType: 'image/jpeg' }),
    );
    expect(file).toMatchObject({
      id: created.id,
      byteSize: 4999,
      etag: '"abc"',
      storageKey: created.storageKey,
      thumbnailStatus: 'pending',
    });
    expect(await withTenant(northwind.id, (tx) => tx.files.findIntent(created.id))).toBeUndefined();
    expect(
      await withTenant(northwind.id, (tx) =>
        tx.files.confirm(created.id, { byteSize: 1, etag: null, contentType: 'image/jpeg' }),
      ),
    ).toBeUndefined();
    expect(await bytesOf(northwind, 'image')).toEqual({
      category: 'image',
      bytes: 4999,
      objects: 1,
    });
  });

  it('gives a document no thumbnail to wait for', async () => {
    const file = await stored(northwind, 20, 'document');
    expect(file.thumbnailStatus).toBe('none');
  });

  it('never lets another company see or confirm the upload', async () => {
    const created = await intent(northwind);
    expect(await withTenant(contoso.id, (tx) => tx.files.findIntent(created.id))).toBeUndefined();
    expect(
      await withTenant(contoso.id, (tx) =>
        tx.files.confirm(created.id, { byteSize: 1, etag: null, contentType: 'image/jpeg' }),
      ),
    ).toBeUndefined();
    const file = await stored(northwind, 10);
    expect(await withTenant(contoso.id, (tx) => tx.files.find(file.id))).toBeUndefined();
    expect(await withTenant(contoso.id, (tx) => tx.files.findMany([file.id]))).toEqual([]);
    expect((await usage(contoso)).totalBytes).toBe(0);
  });

  it('lists intents whose window has passed, and only those', async () => {
    const live = await intent(northwind);
    const expired = await intent(northwind, { expiresAt: new Date(Date.now() + 1000) });
    const later = new Date(Date.now() + 60_000);
    const found = await withTenant(northwind.id, (tx) => tx.files.listExpiredIntents(later));
    expect(found.map((entry) => entry.id)).toEqual([expired.id]);
    expect(found.map((entry) => entry.id)).not.toContain(live.id);
  });
});

describe('the usage rollup', () => {
  it('counts files and thumbnails, keeps deleted files until purged, then lets them go', async () => {
    const photo = await stored(northwind, 3000);
    await stored(northwind, 700);
    await stored(northwind, 250, 'document');

    expect(
      await withTenant(northwind.id, (tx) =>
        tx.files.recordThumbnail(photo.id, { key: 't/1', bytes: 90 }),
      ),
    ).toBe(true);
    expect(await bytesOf(northwind, 'thumbnail')).toEqual({
      category: 'thumbnail',
      bytes: 90,
      objects: 1,
    });

    await withTenant(northwind.id, (tx) =>
      tx.files.softDelete(photo.id, ADMIN, new Date(Date.now() + 30 * DAY)),
    );
    expect(await usage(northwind)).toMatchObject({ totalBytes: 4040, totalObjects: 4 });

    const beyond = new Date(Date.now() + 31 * DAY);
    const due = await withTenant(northwind.id, (tx) => tx.files.listDueForPurge(beyond));
    expect(due.map((entry) => entry.id)).toEqual([photo.id]);
    expect(await withTenant(northwind.id, (tx) => tx.files.markPurged(photo.id, beyond))).toBe(
      true,
    );

    expect(await bytesOf(northwind, 'image')).toEqual({
      category: 'image',
      bytes: 700,
      objects: 1,
    });
    expect(await bytesOf(northwind, 'thumbnail')).toEqual({
      category: 'thumbnail',
      bytes: 0,
      objects: 0,
    });
    expect(await usage(northwind)).toMatchObject({ totalBytes: 950, totalObjects: 2 });
  });

  it('equals the sum of the ledger after a mixed history', async () => {
    const files: Awaited<ReturnType<typeof stored>>[] = [];
    for (const size of [11, 222, 3333, 44_444, 5]) {
      files.push(await stored(northwind, size));
    }
    await withTenant(northwind.id, async (tx) => {
      await tx.files.recordThumbnail(files[0]!.id, { key: 't/a', bytes: 7 });
      await tx.files.softDelete(files[1]!.id, ADMIN, new Date(Date.now() + 1000));
      await tx.files.softDelete(files[2]!.id, ADMIN, new Date(Date.now() + 30 * DAY));
      await tx.files.restore(files[2]!.id, new Date());
      await tx.files.markPurged(files[1]!.id, new Date(Date.now() + 2000));
    });
    const ledger = await owner.query<{ bytes: string; objects: string }>(
      `select (coalesce(sum(byte_size), 0) + coalesce(sum(thumbnail_bytes), 0))::text as bytes,
              (count(*) + count(thumbnail_bytes))::text as objects
         from files where tenant_id = $1 and purged_at is null`,
      [northwind.id],
    );
    expect(await usage(northwind)).toMatchObject({
      totalBytes: Number(ledger.rows[0]!.bytes),
      totalObjects: Number(ledger.rows[0]!.objects),
    });
    expect((await usage(northwind)).totalBytes).toBe(11 + 7 + 3333 + 44_444 + 5);
  });

  it('cannot be written by the runtime role', async () => {
    await stored(northwind, 100);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update tenant_storage_usage set bytes = 0 where tenant_id = $1`, [northwind.id]),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into tenant_storage_usage (tenant_id, category, bytes) values ($1, 'video', 5)`,
          [northwind.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});

describe('the ledger is immutable', () => {
  it('refuses to change what storage confirmed, for the runtime role and the owner alike', async () => {
    const file = await stored(northwind, 100);
    for (const column of [
      'byte_size = 1',
      'etag = \'"forged"\'',
      "content_type = 'image/png'",
      "storage_key = 'x'",
    ]) {
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`update files set ${column} where id = $1`, [file.id]),
        ),
      ).rejects.toThrow(/cannot be changed/u);
    }
    await expect(
      owner.query(`update files set byte_size = 1 where id = $1`, [file.id]),
    ).rejects.toThrow(/cannot be changed/u);
    expect((await bytesOf(northwind, 'image')).bytes).toBe(100);
  });

  it('refuses to let the runtime role delete a ledger row or write one to another company', async () => {
    const file = await stored(northwind, 100);
    await expect(
      asTenant(app, northwind.id, () => app.query(`delete from files where id = $1`, [file.id])),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `insert into files (id, tenant_id, bucket, storage_key, byte_size, content_type, category, uploaded_by)
           values (gen_random_uuid(), $1, 'b-b-b', 'k', 1, 'image/jpeg', 'image', $2)`,
          [contoso.id, ENGINEER],
        ),
      ),
    ).rejects.toThrow(/row-level security/u);
  });

  it('restores inside the window, not after it, and never after purge', async () => {
    const file = await stored(northwind, 100);
    const soon = new Date(Date.now() + 30 * DAY);
    await withTenant(northwind.id, (tx) => tx.files.softDelete(file.id, ADMIN, soon));
    expect(
      await withTenant(northwind.id, (tx) => tx.files.softDelete(file.id, ADMIN, soon)),
    ).toBeUndefined();

    const restored = await withTenant(northwind.id, (tx) => tx.files.restore(file.id, new Date()));
    expect(restored).toMatchObject({ deletedAt: null, deletedBy: null, purgeAfter: null });

    await withTenant(northwind.id, (tx) => tx.files.softDelete(file.id, ADMIN, soon));
    const after = new Date(soon.getTime() + 1000);
    expect(
      await withTenant(northwind.id, (tx) => tx.files.restore(file.id, after)),
    ).toBeUndefined();

    await withTenant(northwind.id, (tx) => tx.files.markPurged(file.id, after));
    await expect(
      owner.query(
        `update files set deleted_at = null, deleted_by = null, purge_after = null, purged_at = null where id = $1`,
        [file.id],
      ),
    ).rejects.toThrow(/cannot be restored/u);
  });

  it('records a thumbnail once', async () => {
    const file = await stored(northwind, 100);
    expect(
      await withTenant(northwind.id, (tx) =>
        tx.files.recordThumbnail(file.id, { key: 't/1', bytes: 9 }),
      ),
    ).toBe(true);
    expect(
      await withTenant(northwind.id, (tx) =>
        tx.files.recordThumbnail(file.id, { key: 't/2', bytes: 1 }),
      ),
    ).toBe(false);
    await expect(
      owner.query(`update files set thumbnail_bytes = 1 where id = $1`, [file.id]),
    ).rejects.toThrow(/already has a thumbnail/u);
  });

  it('knows when a submission, or its history, names the file', async () => {
    const file = await stored(northwind, 100);
    expect(await withTenant(northwind.id, (tx) => tx.files.isReferenced(file.id))).toBe(false);
    const form = await withTenant(northwind.id, async (tx) => {
      const created = await tx.forms.createForm({ title: 'Photos', createdBy: ADMIN });
      const draft = await tx.forms.createDraft({
        formId: created.id,
        definition: {
          schemaVersion: 1,
          title: { en: 'Photos' },
          pages: [
            {
              id: 'page_1',
              sections: [
                {
                  id: 'section_1',
                  fields: [{ id: 'photo', type: 'photo', label: { en: 'Photo' } }],
                },
              ],
            },
          ],
        },
        createdBy: ADMIN,
      });
      return (await tx.forms.publishDraft(draft.id, ADMIN))!;
    });
    await withTenant(northwind.id, (tx) =>
      tx.submissions.startDraft({
        formVersionId: form.id,
        submittedBy: ENGINEER,
        answers: { photo: [{ mediaId: file.id, contentType: 'image/jpeg', byteSize: 100 }] },
      }),
    );
    expect(await withTenant(northwind.id, (tx) => tx.files.isReferenced(file.id))).toBe(true);
    expect(await withTenant(contoso.id, (tx) => tx.files.isReferenced(file.id))).toBe(false);
  });
});

describe('storage registry', () => {
  it('records one bucket per company, idempotently, readable only by its company', async () => {
    const again = await getPlatformDataSource().storage.record({
      tenantId: northwind.id,
      provider: 'r2',
      bucket: 'something-else',
    });
    expect(again).toMatchObject({ provider: 'local', bucket: bucketOf(northwind) });
    expect((await getPlatformDataSource().storage.listActive()).length).toBe(2);

    const visible = await asTenant(app, contoso.id, () =>
      app.query('select tenant_id from tenant_storage'),
    );
    expect(visible.rows).toEqual([{ tenant_id: contoso.id }]);
    await expect(
      asTenant(app, contoso.id, () =>
        app.query(`update tenant_storage set bucket = 'stolen-bucket' where tenant_id = $1`, [
          contoso.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/u);
  });

  it('refuses a bucket name R2 would refuse', async () => {
    await expect(
      getPlatformDataSource().storage.record({
        tenantId: (await createTenant('fabrikam')).id,
        provider: 'r2',
        bucket: 'Not_A_Bucket',
      }),
    ).rejects.toThrow(/tenant_storage_bucket_name/u);
  });

  it('purges a company’s records to zero, leaving the other company untouched', async () => {
    await stored(northwind, 100);
    await stored(northwind, 200, 'document');
    await intent(northwind);
    await stored(contoso, 50);

    expect(await getPlatformDataSource().storage.purgeRecords(northwind.id)).toEqual({
      files: 2,
      intents: 1,
    });
    expect(await usage(northwind)).toMatchObject({ totalBytes: 0, totalObjects: 0 });
    expect((await getPlatformDataSource().storage.find(northwind.id))?.purgedAt).toBeInstanceOf(
      Date,
    );
    expect(
      (await getPlatformDataSource().storage.listActive()).map((entry) => entry.tenantId),
    ).toEqual([contoso.id]);
    expect(await usage(contoso)).toMatchObject({ totalBytes: 50, totalObjects: 1 });
  });
});
