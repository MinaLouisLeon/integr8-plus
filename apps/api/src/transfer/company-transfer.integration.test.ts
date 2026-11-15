import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeIdentityProvider } from '@integr8/auth';
import { getPlatformDataSource } from '@integr8/db';
import {
  companyFingerprints,
  makeVolumeCompany,
  purgeCompanyNow,
  requireDisposableDatabase,
} from '@integr8/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalDiskStorage } from '../media/local-disk.js';
import { getStorage, provisionTenantStorage } from '../media/tenant-storage.js';
import { type ApiHarness, startApi } from '../testing/api-harness.js';
import { ArchiveWriter } from './archive.js';
import { exportCompany, importCompany, inspectArchive } from './company-transfer.js';

/**
 * A company moved through the archive and back (P41): rows byte-identical,
 * files with their types, and the refusals that keep a bad archive out. The
 * row-level round trip on volume is proven in `@integr8/db`'s transfer suite;
 * this one is the archive and what travels with the rows.
 */

let api: ApiHarness;
let directory: string;
let media: LocalDiskStorage;
let tenantId: string;
const admin = (): string => requireDisposableDatabase().adminUrl;

beforeAll(async () => {
  api = await startApi();
  directory = await mkdtemp(join(tmpdir(), 'integr8-transfer-'));
  media = new LocalDiskStorage({
    directory: join(directory, 'media'),
    secret: 'transfer-suite',
    publicUrl: 'http://localhost:3000',
  });
  tenantId = await makeVolumeCompany();
  await provisionTenantStorage(media, tenantId);
  const store = await getStorage(media, tenantId);
  await store.put({
    key: 'media/00000000-0000-4000-8000-0000000000f1',
    body: new TextEncoder().encode('a photo'),
    contentType: 'image/jpeg',
  });
}, 120_000);

afterAll(async () => {
  await api.close();
  await rm(directory, { recursive: true, force: true });
});

describe('moving a company to another server', () => {
  it('brings back the same rows and the same files', async () => {
    const before = await companyFingerprints(tenantId);
    const file = join(directory, 'company.tar.gz');

    const exported = await exportCompany({
      adminConnectionString: admin(),
      media,
      tenantId,
      out: file,
      withFiles: true,
      withPasswords: true,
    });
    expect(exported.rows).toBeGreaterThan(100);
    expect(exported.files).toBe(1);

    const manifest = await inspectArchive(file);
    expect(manifest.company.id).toBe(tenantId);
    expect(manifest.modules.field_work).toContain('work_orders');

    // The other server: the company is gone, and so is its storage.
    await purgeCompanyNow(tenantId);
    await media.destroy(media.bucketFor(tenantId));

    const imported = await importCompany({
      adminConnectionString: admin(),
      media,
      identity: new FakeIdentityProvider(),
      file,
    });

    expect(await companyFingerprints(tenantId)).toEqual(before);
    expect(imported.files).toEqual({ uploaded: 1, alreadyThere: 0 });
    const store = await getStorage(media, tenantId);
    expect(await store.head('media/00000000-0000-4000-8000-0000000000f1')).toMatchObject({
      contentType: 'image/jpeg',
    });

    const audit = await getPlatformDataSource().platformAudit.list({
      tenantId,
      action: 'company.imported',
    });
    expect(audit.entries).toHaveLength(1);
  });

  it('refuses a company this server already has, and changes nothing', async () => {
    const before = await companyFingerprints(tenantId);
    const file = join(directory, 'again.tar.gz');
    await exportCompany({
      adminConnectionString: admin(),
      media,
      tenantId,
      out: file,
      withFiles: false,
      withPasswords: false,
    });

    await expect(
      importCompany({
        adminConnectionString: admin(),
        media,
        identity: new FakeIdentityProvider(),
        file,
      }),
    ).rejects.toThrow(/already exists on this server/u);
    expect(await companyFingerprints(tenantId)).toEqual(before);
  });

  it('refuses an archive from a newer release', async () => {
    const file = join(directory, 'future.tar.gz');
    const writer = new ArchiveWriter(file);
    await writer.add(
      'manifest.json',
      JSON.stringify({
        format: 'integr8-company-transfer',
        formatVersion: 1,
        release: '9.0.0',
        schemaVersion: '9999',
        exportedAt: new Date().toISOString(),
        company: { id: tenantId, slug: 'future', name: 'Future' },
        includes: { files: false, passwords: false },
        modules: {},
        tables: [],
      }),
    );
    await writer.close();

    await expect(inspectArchive(file)).rejects.toThrow(/newer than this server/u);
  });

  it('refuses a file that is not a company transfer', async () => {
    const file = join(directory, 'other.tar.gz');
    const writer = new ArchiveWriter(file);
    await writer.add('readme.txt', 'hello');
    await writer.close();

    await expect(inspectArchive(file)).rejects.toThrow(/not a company transfer/u);
  });
});
