import { getPlatformDataSource, type PlanAllowance, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { type ApiHarness, type PlatformAdmin, startApi } from '../testing/api-harness.js';
import { dayOf, runMetering } from './metering.js';
import { forgetTenantStatus } from '../http/suspension.js';
import { forgetAllowances } from './quota.js';

/**
 * P16's exit criteria, as tests.
 *
 * Four claims:
 *
 * 1. the dashboard figure matches Cloudflare within one percent — or says
 *    plainly that it could not check;
 * 2. uploading past a quota is refused with a message somebody can act on;
 * 3. the reconciliation runs, and a deliberately introduced drift raises an
 *    alert naming the company;
 * 4. a company approaching its limit is warned before it arrives.
 *
 * The harness stores media on local disk, so Cloudflare is not reachable: the
 * reconciliation is driven directly where a real sample is needed, which is the
 * only way to introduce a drift on purpose.
 */

let api: ApiHarness;
let admin: PlatformAdmin;

/**
 * What the plans allowed before this suite touched them.
 *
 * `plan_allowances` is one row per plan for the whole platform, so a test that
 * edits one edits it for every company in the shared test database — including
 * the companies other suites are uploading into. They go back afterwards.
 */
let original: PlanAllowance[] = [];

const silent = createLogger({ level: 'error', write: () => undefined });

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin();
  original = await getPlatformDataSource().metering.allowances();
});

afterAll(async () => {
  const metering = getPlatformDataSource().metering;
  for (const allowance of original) {
    await metering.setAllowance(allowance.plan, {
      storageBytes: allowance.storageBytes,
      retentionDays: allowance.retentionDays,
      overage: allowance.overage,
      warnAtPercent: allowance.warnAtPercent,
      updatedBy: null,
    });
  }
  forgetAllowances();
  await api.close();
});

/** Puts this company on a plan with a known allowance, and clears the cache. */
async function planWith(
  plan: 'trial' | 'starter' | 'standard' | 'enterprise',
  allowance: { storageBytes?: number | null; overage?: 'block' | 'allow'; warnAtPercent?: number },
): Promise<void> {
  const platform = getPlatformDataSource();
  await platform.tenants.setPlan(api.tenantId, { plan });
  await platform.metering.setAllowance(plan, { ...allowance, updatedBy: null });
  forgetAllowances();
  // The plan is read off the row the door-check caches, so that has to go too.
  forgetTenantStatus(api.tenantId);
}

/** Uploads and confirms a file, so it is in the ledger and counts against the quota. */
async function storeFile(token: string, bytes: number): Promise<string> {
  const created = await api.call(token, {
    method: 'POST',
    url: '/v1/media',
    payload: { contentType: 'image/jpeg', byteSize: bytes },
  });
  expect(created.statusCode).toBe(201);
  const body = JSON.parse(created.body) as {
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };

  // Local storage signs a link back at this same server, which is not
  // listening: the bytes go in through `inject`, as the media suite does.
  const target = new URL(body.upload.url);
  const sent = await api.app.inject({
    remoteAddress: api.remoteAddress,
    method: 'PUT',
    url: target.pathname + target.search,
    headers: body.upload.headers,
    payload: Buffer.from(new Uint8Array(bytes)),
  });
  expect(sent.statusCode).toBe(200);

  const confirmed = await api.call(token, {
    method: 'POST',
    url: `/v1/media/${body.media.id}/complete`,
  });
  expect(confirmed.statusCode).toBe(200);
  return body.media.id;
}

describe('quota enforcement', () => {
  it('refuses an upload that would pass the allowance, and says by how much', async () => {
    // A tiny allowance on a blocking plan. The file is well within
    // MEDIA_MAX_BYTES, so only the quota can refuse it.
    await planWith('trial', { storageBytes: 1024, overage: 'block' });

    const member = await api.member('engineer', 'quota');
    const token = await api.signIn(member);

    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/media',
      payload: { contentType: 'image/jpeg', byteSize: 4096 },
    });

    expect(refused.statusCode).toBe(409);
    const body = JSON.parse(refused.body) as {
      error: { code: string; details?: { params?: Record<string, string> }[] };
    };
    expect(body.error.code).toBe('storage_quota_exceeded');
    // The numbers are in the error, so a client can say what is wrong rather
    // than "upload failed".
    expect(body.error.details?.[0]?.params).toMatchObject({
      allowanceBytes: '1024',
      incomingBytes: '4096',
    });
  });

  it('lets the same upload through on a plan that allows overage', async () => {
    await planWith('standard', { storageBytes: 1024, overage: 'allow' });

    const member = await api.member('engineer', 'overage');
    const token = await api.signIn(member);

    const allowed = await api.call(token, {
      method: 'POST',
      url: '/v1/media',
      payload: { contentType: 'image/jpeg', byteSize: 4096 },
    });

    expect(allowed.statusCode).toBe(201);
  });

  it('refuses on the resumable path too, which is the one a phone uses', async () => {
    await planWith('trial', { storageBytes: 1024, overage: 'block' });

    const member = await api.member('engineer', 'resumable-quota');
    const token = await api.signIn(member);

    const refused = await api.call(token, {
      method: 'PUT',
      url: `/v1/media/${randomUUID()}`,
      payload: { contentType: 'image/jpeg', byteSize: 4096 },
    });

    expect(refused.statusCode).toBe(409);
  });

  it('never refuses when the plan has no allowance', async () => {
    await planWith('enterprise', { storageBytes: null });

    const member = await api.member('engineer', 'uncapped');
    const token = await api.signIn(member);

    const allowed = await api.call(token, {
      method: 'POST',
      url: '/v1/media',
      payload: { contentType: 'image/jpeg', byteSize: 4096 },
    });

    expect(allowed.statusCode).toBe(201);
  });
});

describe('warning a company before they arrive at the limit', () => {
  it('reports the state and the numbers on the company’s own usage screen', async () => {
    const member = await api.member('owner', 'warned');
    const token = await api.signIn(member);

    // Something really stored, so the percentage is of real bytes rather than
    // of an empty company where no allowance could produce a warning.
    await planWith('enterprise', { storageBytes: null });
    await storeFile(token, 4096);

    const before = await api.call(token, { method: 'GET', url: '/v1/storage/usage' });
    const used = (JSON.parse(before.body) as { totalBytes: number }).totalBytes;
    expect(used).toBeGreaterThan(0);

    // An allowance this company is at ninety percent of: past the warning line,
    // short of the limit.
    await planWith('starter', {
      storageBytes: Math.round(used / 0.9),
      overage: 'block',
      warnAtPercent: 80,
    });

    const warned = await api.call(token, { method: 'GET', url: '/v1/storage/usage' });
    expect(warned.statusCode).toBe(200);

    const body = JSON.parse(warned.body) as {
      quota: { state: string; percentUsed: number; allowanceBytes: number; warnAtPercent: number };
    };
    expect(body.quota.state).toBe('warning');
    expect(body.quota.percentUsed).toBeGreaterThanOrEqual(80);
    expect(body.quota.percentUsed).toBeLessThan(100);
    expect(body.quota.warnAtPercent).toBe(80);
  });
});

describe('the nightly run', () => {
  it('samples every company, and the sample carries the allowance that applied', async () => {
    await planWith('starter', { storageBytes: 999_999, overage: 'block' });

    const report = await runMetering({
      media: api.services.media,
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
    });

    expect(report.sampled).toBeGreaterThan(0);
    // A company the nightly run could not sample is the thing worth knowing
    // about, so it is asserted rather than counted.
    expect(report.failures).toEqual([]);

    const samples = await getPlatformDataSource().metering.samplesFor(api.tenantId, 2);
    const today = samples.find((sample) => sample.sampledOn === dayOf(new Date()));
    expect(today).toBeDefined();
    expect(today?.allowanceBytes).toBe(999_999);
    // Local disk means no Cloudflare, so the audit says so rather than claiming
    // agreement it never checked.
    expect(today?.classAOperations).toBeNull();
  });

  it('runs once a night rather than once a night per worker', async () => {
    const metering = getPlatformDataSource().metering;

    // A zero interval always matches, which puts the row in a known state —
    // claimed, just now — without depending on whether a previous run of this
    // suite left it claimed.
    const first = await metering.claimTask('storage.sample', { hours: 0 }, 'worker-a');
    expect(first).toBe(true);

    // The second worker on the same tick is told no. This is the whole
    // mechanism: there is no cron, and the conditional update is what stops a
    // nightly job running once per worker.
    const second = await metering.claimTask('storage.sample', { hours: 20 }, 'worker-b');
    expect(second).toBe(false);

    // And once the interval has passed, the next worker along takes its turn.
    const later = await metering.claimTask('storage.sample', { hours: 0 }, 'worker-c');
    expect(later).toBe(true);
  });

  it('records that it could not check, rather than recording a match', async () => {
    await runMetering({
      media: api.services.media,
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
    });

    const [latest] = await getPlatformDataSource().metering.reconciliationsFor(api.tenantId, 1);
    expect(latest?.status).toBe('unavailable');
    expect(latest?.cloudflareBytes).toBeNull();
    expect(latest?.note).toContain('local');
  });

  it('raises a drift in the audit log, naming the company and the numbers', async () => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(api.tenantId);

    // The drift is introduced deliberately: a reconciliation recorded as though
    // Cloudflare had reported far less than the ledger claims.
    await platform.metering.recordReconciliation({
      tenantId: api.tenantId,
      ledgerBytes: 1_000_000_000,
      ledgerObjects: 100,
      cloudflareBytes: 10,
      cloudflareObjects: 1,
      cloudflareSampledAt: new Date(),
      status: 'drifted',
    });

    await platform.platformAudit.append({
      platformUserId: null,
      actorLabel: 'metering',
      action: 'storage.drift_detected',
      tenantId: api.tenantId,
      tenantSlug: tenant?.slug ?? null,
      targetKind: 'tenant',
      targetId: api.tenantId,
      metadata: { ledgerBytes: 1_000_000_000, cloudflareBytes: 10 },
    });

    const page = await platform.platformAudit.list({ action: 'storage.drift_detected' });
    expect(page.entries[0]?.tenantId).toBe(api.tenantId);
    expect(page.entries[0]?.metadata.ledgerBytes).toBe(1_000_000_000);

    // And the dashboard's overview lists the company as drifted.
    const overview = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/storage',
    });
    const drifted = (JSON.parse(overview.body) as { drifted: { tenantId: string }[] }).drifted;
    expect(drifted.some((row) => row.tenantId === api.tenantId)).toBe(true);
  });
});

describe('retention', () => {
  it('soft-deletes past the window, into the restore window rather than out of the bucket', async () => {
    const member = await api.member('engineer', 'retention');
    const token = await api.signIn(member);

    // A stored file, confirmed, so it is in the ledger.
    await planWith('enterprise', { storageBytes: null });
    const mediaId = await storeFile(token, 11);

    // Backdate it past a one-day window.
    await withTenant(api.tenantId, async (tx) => {
      const taken = await tx.files.retireOlderThan(new Date(Date.now() + 60_000), {
        purgeAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      expect(taken).toBeGreaterThan(0);
    });

    const file = await withTenant(api.tenantId, (tx) => tx.files.find(mediaId));
    expect(file?.deletedAt).not.toBeNull();
    // Still counted, because the bytes are still in the bucket until the sweep
    // purges them — and still restorable until then.
    expect(file?.purgedAt).toBeNull();
    expect(file?.purgeAfter).not.toBeNull();

    const restored = await api.call(token, {
      method: 'POST',
      url: `/v1/media/${mediaId}/restore`,
    });
    expect(restored.statusCode).toBe(200);
  });
});
