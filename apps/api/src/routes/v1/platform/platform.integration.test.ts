import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeOne } from '../../../platform/purge.js';
import { createLogger } from '../../../http/logger.js';
import { forgetTenantStatus } from '../../../http/suspension.js';
import { runTenantExport } from '../../../platform/export.js';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * P15's exit criteria, as tests.
 *
 * Four claims, each of which is the kind of thing that is easy to believe and
 * expensive to be wrong about:
 *
 * 1. a company is onboarded end to end with no manual database or Cloudflare
 *    step;
 * 2. every impersonation appears in the audit log with its reason and duration;
 * 3. suspending a company stops all three apps being served;
 * 4. deleting a company removes its rows and its bucket.
 *
 * The harness uses local disk rather than R2, so (4) checks that the bucket's
 * objects and its registry row are gone. The R2 half is exercised by the media
 * suite, which runs against the real account when it is configured.
 */

let api: ApiHarness;
let admin: PlatformAdmin;

const silent = createLogger({ level: 'error', write: () => undefined });

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin();
});

afterAll(async () => {
  await api.close();
});

function slug(): string {
  return `p15-${randomUUID().slice(0, 8)}`;
}

describe('signing in to the dashboard', () => {
  it('refuses a platform route to a tenant token, and a tenant route to a platform token', async () => {
    const owner = await api.member('owner', 'owner');
    const tenantToken = await api.signIn(owner);

    const asTenant = await api.call(tenantToken, {
      method: 'GET',
      url: '/v1/platform/companies',
    });
    expect(asTenant.statusCode).toBe(401);

    // And the other way: a platform token is not a session in any company.
    const asPlatform = await api.call(admin.accessToken, { method: 'GET', url: '/v1/me' });
    expect(asPlatform.statusCode).toBe(401);
  });

  it('stops accepting the token as soon as the session is signed out', async () => {
    const other = await api.platformAdmin('signout');

    expect(
      (await api.call(other.accessToken, { method: 'GET', url: '/v1/platform/me' })).statusCode,
    ).toBe(200);

    await api.call(other.accessToken, {
      method: 'POST',
      url: '/v1/platform/auth/sign-out',
      payload: {},
    });

    expect(
      (await api.call(other.accessToken, { method: 'GET', url: '/v1/platform/me' })).statusCode,
    ).toBe(401);
  });
});

describe('onboarding a company', () => {
  it('creates the company, its job types, its owner invitation and its bucket in one call', async () => {
    const name = slug();
    const response = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: {
        slug: name,
        name: 'Northwind Facilities',
        plan: 'starter',
        seats: 25,
        ownerEmail: `owner@${name}.example`,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      company: { id: string; slug: string; plan: string; seats: number };
      ownerInvitation: { email: string };
      storage: { bucket: string; created: boolean };
    };

    expect(body.company.slug).toBe(name);
    expect(body.company.plan).toBe('starter');
    expect(body.company.seats).toBe(25);
    expect(body.ownerInvitation.email).toBe(`owner@${name}.example`);
    expect(body.storage.bucket).not.toBe('');

    // No manual step: the job types, the invitation and the bucket are all
    // there without anybody opening a terminal.
    const inside = await withTenant(body.company.id, async (tx) => ({
      jobTypes: (await tx.jobTypes.list()).length,
      invitations: (await tx.invitations.listPending()).length,
    }));
    expect(inside.jobTypes).toBeGreaterThan(0);
    expect(inside.invitations).toBe(1);

    const bucket = await getPlatformDataSource().storage.find(body.company.id);
    expect(bucket?.bucket).toBe(body.storage.bucket);
  });

  it('refuses a slug somebody already has', async () => {
    const name = slug();
    const payload = { slug: name, name: 'First', ownerEmail: `a@${name}.example` };

    expect(
      (
        await api.call(admin.accessToken, {
          method: 'POST',
          url: '/v1/platform/companies',
          payload,
        })
      ).statusCode,
    ).toBe(201);

    const second = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: { ...payload, name: 'Second' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('writes every one of these to the platform audit log', async () => {
    const audit = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/audit?action=tenant.onboarded',
    });

    expect(audit.statusCode).toBe(200);
    const body = JSON.parse(audit.body) as { entries: { actorLabel: string; action: string }[] };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.entries[0]?.actorLabel).toBe(admin.email);
  });
});

describe('suspending a company', () => {
  it('refuses every request from that company, reads included, with the reason', async () => {
    const member = await api.member('owner', 'suspended');
    const token = await api.signIn(member);

    expect((await api.call(token, { method: 'GET', url: '/v1/me' })).statusCode).toBe(200);

    const suspended = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/suspend`,
      payload: { reason: 'Unpaid invoices since March' },
    });
    expect(suspended.statusCode).toBe(200);

    try {
      const refused = await api.call(token, { method: 'GET', url: '/v1/me' });
      expect(refused.statusCode).toBe(423);
      expect(refused.body).toContain('Unpaid invoices since March');

      // A write is refused the same way: this is not read-only, it is stopped.
      const write = await api.call(token, {
        method: 'POST',
        url: '/v1/members/invitations',
        payload: { email: 'nobody@test.integr8.example', role: 'engineer' },
      });
      expect(write.statusCode).toBe(423);
    } finally {
      // Whatever happened above, the company goes back: every other suite in
      // this file shares it, and a failure here must not become five failures.
      const back = await api.call(admin.accessToken, {
        method: 'POST',
        url: `/v1/platform/companies/${api.tenantId}/reactivate`,
        payload: {},
      });
      expect(back.statusCode).toBe(200);
    }

    expect((await api.call(token, { method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
  });
});

describe('impersonation', () => {
  it('appears in the platform audit log with its reason, and its duration once ended', async () => {
    const target = await api.member('owner', 'impersonated');

    const started = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/impersonate`,
      payload: {
        targetUserId: target.userId,
        reason: 'Customer reported a missing job sheet on ticket 4182',
      },
    });
    expect(started.statusCode).toBe(201);
    const grant = JSON.parse(started.body) as {
      grantId: string;
      tokens: { accessToken: string };
    };

    // The token acts as the target, and says who is really behind it.
    const asTarget = await api.call(grant.tokens.accessToken, { method: 'GET', url: '/v1/me' });
    expect(asTarget.statusCode).toBe(200);
    const me = JSON.parse(asTarget.body) as {
      userId: string;
      impersonatedBy?: { platformUserId: string; grantId: string };
    };
    expect(me.userId).toBe(target.userId);
    expect(me.impersonatedBy).toEqual({ platformUserId: admin.id, grantId: grant.grantId });

    const audited = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/audit?action=impersonation.started',
    });
    const entries = (JSON.parse(audited.body) as { entries: { reason: string | null }[] }).entries;
    expect(entries[0]?.reason).toBe('Customer reported a missing job sheet on ticket 4182');

    // One click to leave, and the token stops working immediately rather than
    // when it would have expired.
    const ended = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${api.tenantId}/impersonate/${grant.grantId}/end`,
      payload: {},
    });
    expect(ended.statusCode).toBe(200);
    // 403 rather than 401: the token is still a genuine token, and what has
    // gone is the grant behind it. `assertStillPermitted` re-checks that on
    // every request, so this takes effect now rather than in fifteen minutes.
    expect(
      (await api.call(grant.tokens.accessToken, { method: 'GET', url: '/v1/me' })).statusCode,
    ).toBe(403);

    const listed = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${api.tenantId}/impersonations`,
    });
    const items = (
      JSON.parse(listed.body) as {
        items: { id: string; reason: string; durationSeconds: number | null }[];
      }
    ).items;
    const record = items.find((item) => item.id === grant.grantId);
    expect(record?.reason).toBe('Customer reported a missing job sheet on ticket 4182');
    expect(record?.durationSeconds).not.toBeNull();
  });
});

describe('exporting and deleting a company', () => {
  it('refuses a deletion until an export is ready, then purges rows and bucket', async () => {
    // A company of its own, because this one does not survive the test.
    const name = slug();
    const created = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: { slug: name, name: 'Doomed Ltd', ownerEmail: `owner@${name}.example` },
    });
    const tenantId = (JSON.parse(created.body) as { company: { id: string } }).company.id;

    // Nothing to delete with: no export exists yet.
    const premature = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/deletion`,
      payload: { exportId: randomUUID(), reason: 'Customer asked us to close the account' },
    });
    expect(premature.statusCode).toBe(404);

    const queued = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/exports`,
      payload: {},
    });
    expect(queued.statusCode).toBe(202);
    const exportId = (JSON.parse(queued.body) as { id: string }).id;

    // A pending export is not an export.
    const tooEarly = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/deletion`,
      payload: { exportId, reason: 'Customer asked us to close the account' },
    });
    expect(tooEarly.statusCode).toBe(409);

    // Run the job the route queued, rather than waiting for a worker.
    await runTenantExport({ exportId, tenantId, media: api.services.media, logger: silent });

    const ready = await getPlatformDataSource().lifecycle.findExport(exportId);
    expect(ready?.status).toBe('ready');
    expect(ready?.contents.job_types).toBeGreaterThan(0);

    const scheduled = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/deletion`,
      payload: { exportId, reason: 'Customer asked us to close the account' },
    });
    expect(scheduled.statusCode).toBe(201);

    // Scheduled, not done: the company is suspended and everything is still
    // there until the cooling-off passes.
    forgetTenantStatus(tenantId);
    expect((await getPlatformDataSource().tenants.findById(tenantId))?.status).toBe('suspended');

    // Cancelling puts it back, which is the whole reason for the delay.
    const cancelled = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/deletion/cancel`,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(await getPlatformDataSource().lifecycle.pendingFor(tenantId)).toBeUndefined();

    // Schedule it again and let the clock run out, then purge.
    const again = await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/deletion`,
      payload: { exportId, reason: 'Customer asked us to close the account' },
    });
    expect(again.statusCode).toBe(201);
    await bringPurgeForward(tenantId);

    await purgeOne(tenantId, { media: api.services.media, logger: silent });

    expect(await getPlatformDataSource().tenants.findById(tenantId)).toBeUndefined();
    expect(await getPlatformDataSource().storage.find(tenantId)).toBeUndefined();

    // And the platform's own record of it survives the company it describes.
    const audit = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/audit?tenantId=${tenantId}`,
    });
    const actions = (JSON.parse(audit.body) as { entries: { action: string }[] }).entries.map(
      (entry) => entry.action,
    );
    expect(actions).toContain('tenant.purged');
    expect(actions).toContain('tenant.onboarded');
  });
});

describe('flags and announcements', () => {
  it('reaches a company through /v1/me, resolved against the default', async () => {
    const member = await api.member('engineer', 'flagged');
    const token = await api.signIn(member);

    await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/flags/night_shifts',
      payload: { description: 'Shifts that cross midnight', defaultEnabled: false },
    });

    const before = JSON.parse((await api.call(token, { method: 'GET', url: '/v1/me' })).body) as {
      features: Record<string, boolean>;
      announcements: unknown[];
    };
    expect(before.features.night_shifts).toBe(false);

    await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/night_shifts`,
      payload: { enabled: true },
    });

    const after = JSON.parse((await api.call(token, { method: 'GET', url: '/v1/me' })).body) as {
      features: Record<string, boolean>;
    };
    expect(after.features.night_shifts).toBe(true);

    // Removing the override is not the same as turning it off: the company goes
    // back to whatever the default is.
    await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/night_shifts`,
      payload: { enabled: null },
    });
    const reset = JSON.parse((await api.call(token, { method: 'GET', url: '/v1/me' })).body) as {
      features: Record<string, boolean>;
    };
    expect(reset.features.night_shifts).toBe(false);
  });

  it('puts a global banner in front of every company, and takes it down again', async () => {
    const member = await api.member('engineer', 'announced');
    const token = await api.signIn(member);

    const created = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/announcements',
      payload: {
        severity: 'warning',
        message: { en: 'Maintenance at 22:00 UTC' },
        dismissible: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const announcementId = (JSON.parse(created.body) as { id: string }).id;

    const showing = JSON.parse((await api.call(token, { method: 'GET', url: '/v1/me' })).body) as {
      announcements: { id: string; message: Record<string, string>; dismissible: boolean }[];
    };
    const banner = showing.announcements.find((item) => item.id === announcementId);
    expect(banner?.message.en).toBe('Maintenance at 22:00 UTC');
    expect(banner?.dismissible).toBe(false);

    await api.call(admin.accessToken, {
      method: 'POST',
      url: `/v1/platform/announcements/${announcementId}/end`,
      payload: {},
    });

    const gone = JSON.parse((await api.call(token, { method: 'GET', url: '/v1/me' })).body) as {
      announcements: { id: string }[];
    };
    expect(gone.announcements.some((item) => item.id === announcementId)).toBe(false);
  });
});

/**
 * Moves a scheduled purge into the past.
 *
 * `purge_tenant()` refuses a deletion that is not yet due, which is the point;
 * a test that waited seven days would not be a test.
 */
async function bringPurgeForward(tenantId: string): Promise<void> {
  const platform = getPlatformDataSource();
  const pending = await platform.lifecycle.pendingFor(tenantId);
  expect(pending).toBeDefined();
  await platform.lifecycle.reschedule(tenantId, new Date(Date.now() - 1000));
}
