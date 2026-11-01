import { randomBytes, randomUUID } from 'node:crypto';
import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Assets over HTTP (CRM/ERP plan, phase E3; ADR-0008): the module switch,
 * who registers and who manages, serials and tags, an engineer's scope,
 * every change on the timeline with the jobs, parts and files that belong to
 * the asset, links to jobs at the asset's site only, and the warranty window.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;
let siteId: string;
let otherSiteId: string;
let jobTypeId: string;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

interface AssetBody {
  id: string;
  reference: string;
  name: string;
  serialNumber: string | null;
  status: string;
  condition: string | null;
  site: { id: string; name: string };
  customer: { id: string; name: string };
  warranty: string;
  tagCode: string;
  tagLink: string | null;
  version: number;
}
interface AssetDetail {
  asset: AssetBody;
  workOrders: { id: string; linkedAt: string }[];
  can: { edit: boolean; record: boolean; attach: boolean };
}
interface Timeline {
  entries: {
    kind: string;
    id: string;
    at: string;
    event?: {
      kind: string;
      changes: Record<string, unknown> | null;
      fromSite: { id: string } | null;
    };
    part?: { quantity: string; explicit: boolean };
    attachment?: { title: string; workOrderId: string | null };
    workOrder?: { id: string };
  }[];
}

const tag = () => randomUUID().slice(0, 6);

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function register(payload: Record<string, unknown> = {}, who: Member = dispatcher) {
  const response = await call(
    who,
    'POST',
    '/v1/assets',
    { name: 'Boiler', siteId, ...payload },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
  return json<AssetDetail>(response);
}

async function newJob(site = siteId) {
  const response = await call(dispatcher, 'POST', '/v1/work-orders', {
    customerId,
    siteId: site,
    jobTypeId,
    crew: [{ userId: engineer.userId, lead: true }],
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ workOrder: { id: string; revision: number } }>(response).workOrder;
}

async function upload(who: Member) {
  const created = json<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(await call(who, 'POST', '/v1/media', { contentType: 'image/jpeg', byteSize: 1_000 }));
  const target = new URL(created.upload.url);
  const put = await api.app.inject({
    remoteAddress: api.remoteAddress,
    method: 'PUT',
    url: target.pathname + target.search,
    headers: created.upload.headers,
    payload: randomBytes(1_000),
  });
  expect(put.statusCode, put.body).toBe(200);
  expect((await call(who, 'POST', `/v1/media/${created.media.id}/complete`)).statusCode).toBe(200);
  return created.media.id;
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('as-staff');
  owner = await api.member('owner', 'as-owner');
  dispatcher = await api.member('dispatcher', 'as-dispatcher');
  engineer = await api.member('engineer', 'as-engineer');
  viewer = await api.member('viewer', 'as-viewer');
  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Boiler service', code: 'boiler' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  const customer = await call(dispatcher, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  customerId = json<{ id: string }>(customer).id;
  for (const name of ['Block A', 'Block B']) {
    const site = await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
      name,
      address: { line1: '1 River Road' },
    });
    expect(site.statusCode, site.body).toBe(201);
    if (name === 'Block A') {
      siteId = json<{ id: string }>(site).id;
    } else {
      otherSiteId = json<{ id: string }>(site).id;
    }
  }
});

afterAll(async () => {
  await api.close();
});

describe('the assets module switch', () => {
  it('refuses every asset route until Integr8 switches it on', async () => {
    const refused = await call(dispatcher, 'GET', '/v1/assets');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag('assets', true);
    expect((await call(dispatcher, 'GET', '/v1/assets')).statusCode).toBe(200);
  });
});

describe('the register', () => {
  it('is kept by the office, numbered, with a tag, and read by viewers', async () => {
    const created = await register({
      serialNumber: `SN-${tag()}`,
      make: 'Vaillant',
      condition: 'good',
      warrantyExpiresOn: '2099-01-01',
    });
    expect(created.asset).toMatchObject({
      name: 'Boiler',
      status: 'active',
      condition: 'good',
      site: { id: siteId, name: 'Block A' },
      customer: { id: customerId, name: 'Riverside Housing' },
      warranty: 'covered',
    });
    expect(created.asset.reference).toMatch(/^AS-\d{6}$/u);
    expect(created.asset.tagCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/u);
    expect(created.can).toEqual({ edit: true, record: true, attach: true });

    const seen = json<AssetDetail>(await call(viewer, 'GET', `/v1/assets/${created.asset.id}`));
    expect(seen.can).toEqual({ edit: false, record: false, attach: false });
    expect(
      (
        await call(viewer, 'PATCH', `/v1/assets/${created.asset.id}`, {
          expectedVersion: 1,
          name: 'x',
        })
      ).statusCode,
    ).toBe(403);

    const twin = await call(
      dispatcher,
      'POST',
      '/v1/assets',
      { name: 'Twin', siteId, serialNumber: ` ${created.asset.serialNumber!.toLowerCase()} ` },
      randomUUID(),
    );
    expect(twin.statusCode).toBe(422);
    expect(code(twin)).toBe('serial_taken');
  });

  it('records every change on the timeline, and refuses a stale version', async () => {
    const created = await register({ name: 'Chiller' });
    const id = created.asset.id;
    const edited = await call(dispatcher, 'PATCH', `/v1/assets/${id}`, {
      expectedVersion: created.asset.version,
      model: 'XR-500',
      locationNote: 'Roof',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const stale = await call(dispatcher, 'PATCH', `/v1/assets/${id}`, {
      expectedVersion: created.asset.version,
      model: 'XR-600',
    });
    expect(stale.statusCode).toBe(409);
    const moved = await call(dispatcher, 'POST', `/v1/assets/${id}/relocate`, {
      expectedVersion: json<AssetDetail>(edited).asset.version,
      siteId: otherSiteId,
      note: 'Moved to Block B',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const out = await call(dispatcher, 'POST', `/v1/assets/${id}/status`, {
      expectedVersion: json<AssetDetail>(moved).asset.version,
      status: 'out_of_service',
    });
    expect(out.statusCode, out.body).toBe(200);
    const condition = await call(dispatcher, 'POST', `/v1/assets/${id}/condition`, {
      condition: 'poor',
      note: 'Compressor noisy',
    });
    expect(json<AssetDetail>(condition).asset.condition).toBe('poor');
    const timeline = json<Timeline>(await call(dispatcher, 'GET', `/v1/assets/${id}/timeline`));
    expect(timeline.entries.map((entry) => entry.event?.kind)).toEqual([
      'condition_recorded',
      'status_changed',
      'relocated',
      'updated',
      'registered',
    ]);
    expect(timeline.entries[2]!.event!.fromSite).toMatchObject({ id: siteId });
    expect(timeline.entries[3]!.event!.changes).toEqual({
      model: [null, 'XR-500'],
      locationNote: [null, 'Roof'],
    });
  });

  it('comes a page at a time when asked, newest first, and whole when not', async () => {
    const created = await register();
    const id = created.asset.id;
    for (const condition of ['good', 'fair', 'poor', 'fair', 'good', 'poor', 'good']) {
      const recorded = await call(dispatcher, 'POST', `/v1/assets/${id}/condition`, { condition });
      expect(recorded.statusCode, recorded.body).toBe(200);
    }
    const whole = json<Timeline & { nextCursor: string | null }>(
      await call(dispatcher, 'GET', `/v1/assets/${id}/timeline`),
    );
    expect(whole.entries).toHaveLength(8);
    expect(whole.nextCursor).toBeNull();

    // "Show older": each page starts where the last one ended, until there is no more.
    const pages: Timeline['entries'][] = [];
    let before: string | null = null;
    do {
      const query: string = before === null ? '' : `&before=${encodeURIComponent(before)}`;
      const page = json<Timeline & { nextCursor: string | null }>(
        await call(dispatcher, 'GET', `/v1/assets/${id}/timeline?limit=3${query}`),
      );
      pages.push(page.entries);
      before = page.nextCursor;
    } while (before !== null);
    expect(pages.map((page) => page.length)).toEqual([3, 3, 2]);
    expect(pages.flat()).toEqual(whole.entries);

    const refused = await call(dispatcher, 'GET', `/v1/assets/${id}/timeline?limit=3&before=nope`);
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('invalid_cursor');
  });

  it('opens from a tag code, a typed code or a scanned link; a reissued tag opens nothing', async () => {
    const created = await register();
    const { tagCode } = created.asset;
    for (const typed of [
      tagCode,
      `${tagCode.slice(0, 4).toLowerCase()}-${tagCode.slice(4)}`,
      encodeURIComponent(`https://app.example.com/a/${tagCode}`),
    ]) {
      const found = await call(viewer, 'GET', `/v1/assets/by-tag/${typed}`);
      expect(found.statusCode, typed).toBe(200);
      expect(json<{ id: string }>(found).id).toBe(created.asset.id);
    }
    const reissued = await call(dispatcher, 'POST', `/v1/assets/${created.asset.id}/tag`, {
      expectedVersion: created.asset.version,
    });
    expect(reissued.statusCode, reissued.body).toBe(200);
    expect(json<AssetDetail>(reissued).asset.tagCode).not.toBe(tagCode);
    expect((await call(viewer, 'GET', `/v1/assets/by-tag/${tagCode}`)).statusCode).toBe(404);
    expect((await call(viewer, 'GET', '/v1/assets/by-tag/not-a-code')).statusCode).toBe(404);
  });

  it('finds by words, serial and reference, and pages newest first', async () => {
    const serial = `FIND-${tag()}`;
    const created = await register({ name: 'Rooftop condenser', serialNumber: serial });
    const ids = async (query: string) =>
      json<{ items: { id: string }[] }>(await call(viewer, 'GET', `/v1/assets?${query}`)).items.map(
        (asset) => asset.id,
      );
    expect(await ids(`q=${serial.toLowerCase()}`)).toEqual([created.asset.id]);
    expect(await ids(`q=${created.asset.reference}`)).toEqual([created.asset.id]);
    expect(await ids('q=condenser')).toContain(created.asset.id);
    const page = json<{ items: unknown[]; nextCursor: string | null }>(
      await call(viewer, 'GET', '/v1/assets?limit=1'),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
  });
});

describe('engineers and jobs', () => {
  it('lets an engineer register only on their job, and see only their sites', async () => {
    const elsewhere = await register({ name: 'Elsewhere pump', siteId: otherSiteId });
    const noJob = await call(
      engineer,
      'POST',
      '/v1/assets',
      { name: 'Found it', siteId },
      randomUUID(),
    );
    expect(noJob.statusCode).toBe(422);
    expect(code(noJob)).toBe('work_order_required');

    const job = await newJob();
    const registered = await call(
      engineer,
      'POST',
      '/v1/assets',
      { name: 'Found on site', workOrderId: job.id, condition: 'fair' },
      randomUUID(),
    );
    expect(registered.statusCode, registered.body).toBe(201);
    const found = json<AssetDetail>(registered);
    expect(found.asset.site.id).toBe(siteId);
    expect(found.workOrders.map((linked) => linked.id)).toEqual([job.id]);
    expect(found.can).toEqual({ edit: false, record: true, attach: true });

    // Their own site: readable. Another site: as if it did not exist.
    expect((await call(engineer, 'GET', `/v1/assets/${found.asset.id}`)).statusCode).toBe(200);
    expect((await call(engineer, 'GET', `/v1/assets/${elsewhere.asset.id}`)).statusCode).toBe(404);
    const listed = json<{ items: { site: { id: string } }[] }>(
      await call(engineer, 'GET', '/v1/assets?limit=200'),
    );
    expect(listed.items.every((asset) => asset.site.id === siteId)).toBe(true);
    // They record condition, but do not edit.
    expect(
      (
        await call(engineer, 'POST', `/v1/assets/${found.asset.id}/condition`, {
          condition: 'good',
          workOrderId: job.id,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(engineer, 'PATCH', `/v1/assets/${found.asset.id}`, {
          expectedVersion: 1,
          name: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('links a job only to its site’s assets that are in use, and shows the job’s work on the asset', async () => {
    await setFlag('inventory', true);
    const job = await newJob();
    const boiler = await register({ name: 'Linked boiler' });
    const away = await register({ name: 'Away boiler', siteId: otherSiteId });

    const wrongSite = await call(dispatcher, 'POST', `/v1/work-orders/${job.id}/assets`, {
      assetId: away.asset.id,
    });
    expect(wrongSite.statusCode).toBe(422);
    expect(code(wrongSite)).toBe('asset_not_at_site');
    const linked = await call(engineer, 'POST', `/v1/work-orders/${job.id}/assets`, {
      assetId: boiler.asset.id,
    });
    expect(linked.statusCode, linked.body).toBe(204);
    expect(
      (
        await call(engineer, 'POST', `/v1/work-orders/${job.id}/assets`, {
          assetId: boiler.asset.id,
        })
      ).statusCode,
    ).toBe(204);
    const onJob = json<{
      items: { id: string }[];
      atSite: { id: string }[];
      can: Record<string, boolean>;
    }>(await call(engineer, 'GET', `/v1/work-orders/${job.id}/assets`));
    expect(onJob.items.map((asset) => asset.id)).toEqual([boiler.asset.id]);
    expect(onJob.atSite.map((asset) => asset.id)).not.toContain(boiler.asset.id);
    expect(onJob.can).toEqual({ link: true, unlink: false, register: true });

    // A part used on the job, and a photo on it: the job has one asset, so both are its.
    const item = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/items', {
        sku: `V-${tag()}`,
        name: 'Valve',
        kind: 'service',
      }),
    );
    const used = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${job.id}/materials`,
      { itemId: item.id, quantity: '2' },
      randomUUID(),
    );
    expect(used.statusCode, used.body).toBe(201);
    const fileId = await upload(engineer);
    const photo = await call(
      engineer,
      'POST',
      '/v1/attachments',
      { owner: { workOrderId: job.id }, fileId, title: 'After the service', kind: 'photo' },
      randomUUID(),
    );
    expect(photo.statusCode, photo.body).toBe(201);
    const plateId = await upload(dispatcher);
    const plate = await call(
      dispatcher,
      'POST',
      '/v1/attachments',
      {
        owner: { assetId: boiler.asset.id },
        fileId: plateId,
        title: 'Rating plate',
        kind: 'photo',
      },
      randomUUID(),
    );
    expect(plate.statusCode, plate.body).toBe(201);

    const timeline = json<Timeline>(
      await call(engineer, 'GET', `/v1/assets/${boiler.asset.id}/timeline`),
    );
    const kinds = timeline.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['event', 'job', 'part', 'attachment']));
    expect(timeline.entries.find((entry) => entry.kind === 'part')!.part).toMatchObject({
      quantity: '2',
      explicit: false,
    });
    expect(
      timeline.entries
        .filter((entry) => entry.kind === 'attachment')
        .map((entry) => entry.attachment!.title)
        .sort(),
    ).toEqual(['After the service', 'Rating plate']);

    // Retired: no new links, no condition; unlinking is the office's.
    const retired = await call(dispatcher, 'POST', `/v1/assets/${boiler.asset.id}/status`, {
      expectedVersion: json<AssetDetail>(
        await call(dispatcher, 'GET', `/v1/assets/${boiler.asset.id}`),
      ).asset.version,
      status: 'retired',
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const late = await call(dispatcher, 'POST', `/v1/work-orders/${(await newJob()).id}/assets`, {
      assetId: boiler.asset.id,
    });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('asset_retired');
    expect(
      (await call(engineer, 'DELETE', `/v1/work-orders/${job.id}/assets/${boiler.asset.id}`))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(dispatcher, 'DELETE', `/v1/work-orders/${job.id}/assets/${boiler.asset.id}`))
        .statusCode,
    ).toBe(204);
  });
});

describe('warranties', () => {
  it('flags those ending within the company’s window', async () => {
    const settings = json<{ warrantyAlertDays: number; version: number }>(
      await call(viewer, 'GET', '/v1/assets/settings'),
    );
    expect(settings).toMatchObject({ warrantyAlertDays: 60, version: 0 });
    expect(
      (
        await call(dispatcher, 'PUT', '/v1/assets/settings', {
          expectedVersion: 0,
          warrantyAlertDays: 400,
        })
      ).statusCode,
    ).toBe(422);
    const saved = await call(dispatcher, 'PUT', '/v1/assets/settings', {
      expectedVersion: 0,
      warrantyAlertDays: 30,
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const ended = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const expiring = await register({ name: 'Expiring', warrantyExpiresOn: soon });
    const covered = await register({ name: 'Covered', warrantyExpiresOn: later });
    const expired = await register({ name: 'Expired', warrantyExpiresOn: ended });
    expect(expiring.asset.warranty).toBe('expiring');
    expect(covered.asset.warranty).toBe('covered');
    expect(expired.asset.warranty).toBe('expired');
    const ids = async (query: string) =>
      json<{ items: { id: string }[] }>(
        await call(viewer, 'GET', `/v1/assets?${query}&limit=200`),
      ).items.map((asset) => asset.id);
    const flagged = await ids('warranty=expiring');
    expect(flagged).toContain(expiring.asset.id);
    expect(flagged).not.toContain(covered.asset.id);
    expect(flagged).not.toContain(expired.asset.id);
    expect(await ids('warranty=expired')).toContain(expired.asset.id);
  });
});

describe('from the phone', () => {
  it('pulls the assets of the engineer’s job sites with their whole history', async () => {
    const job = await newJob();
    const boiler = await register({ name: 'Pulled boiler', serialNumber: `PULL-${tag()}` });
    expect(
      (
        await call(dispatcher, 'POST', `/v1/assets/${boiler.asset.id}/condition`, {
          condition: 'fair',
          note: 'Seen by the office',
        })
      ).statusCode,
    ).toBe(200);
    const away = await register({ name: 'Away chiller', siteId: otherSiteId });
    const pulled = json<{
      assetSiteIds: string[];
      assets: { asset: { id: string; tagCode: string }; timeline: { kind: string }[] }[];
    }>(await call(engineer, 'GET', '/v1/sync/pull'));
    expect(pulled.assetSiteIds).toContain(siteId);
    expect(pulled.assetSiteIds).not.toContain(otherSiteId);
    const mine = pulled.assets.find((entry) => entry.asset.id === boiler.asset.id);
    expect(mine?.timeline.map((entry) => entry.kind)).toEqual(expect.arrayContaining(['event']));
    expect(pulled.assets.some((entry) => entry.asset.id === away.asset.id)).toBe(false);
    expect(job.id).toBeDefined();
  });

  it('registers, records and links from the outbox, each once', async () => {
    const job = await newJob();
    const push = (mutations: Record<string, unknown>[]) =>
      call(engineer, 'POST', '/v1/sync/push', { sentAt: new Date().toISOString(), mutations });
    const assetId = randomUUID();
    const registration = {
      id: randomUUID(),
      entityId: assetId,
      recordedAt: new Date().toISOString(),
      kind: 'asset.register',
      payload: { workOrderId: job.id, name: 'Found pump', condition: 'poor' },
    };
    const first = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([registration]),
    );
    expect(first.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: false });
    const again = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([{ ...registration, id: randomUUID() }]),
    );
    expect(again.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: true });
    const found = json<AssetDetail>(await call(engineer, 'GET', `/v1/assets/${assetId}`));
    expect(found.asset).toMatchObject({
      name: 'Found pump',
      condition: 'poor',
      site: { id: siteId },
    });
    expect(found.workOrders.map((linked) => linked.id)).toEqual([job.id]);

    const condition = {
      id: randomUUID(),
      entityId: assetId,
      recordedAt: new Date().toISOString(),
      kind: 'asset.condition',
      payload: { condition: 'good', note: 'Fixed', workOrderId: job.id },
    };
    expect(
      json<{ results: { outcome: string }[] }>(await push([condition, condition])).results.map(
        (result) => result.outcome,
      ),
    ).toEqual(['applied', 'applied']);
    const timeline = json<Timeline>(await call(engineer, 'GET', `/v1/assets/${assetId}/timeline`));
    expect(
      timeline.entries.filter((entry) => entry.event?.kind === 'condition_recorded'),
    ).toHaveLength(2);

    const other = await register({ name: 'Second asset' });
    const link = {
      id: randomUUID(),
      entityId: job.id,
      recordedAt: new Date().toISOString(),
      kind: 'asset.link',
      payload: { assetId: other.asset.id },
    };
    expect(json<{ results: { outcome: string }[] }>(await push([link])).results[0]).toMatchObject({
      outcome: 'applied',
    });
    const away = await register({ name: 'Elsewhere', siteId: otherSiteId });
    const refused = json<{ results: { outcome: string; code: string }[] }>(
      await push([{ ...link, id: randomUUID(), payload: { assetId: away.asset.id } }]),
    );
    expect(refused.results[0]).toMatchObject({ outcome: 'rejected', code: 'asset_not_at_site' });
  });
});

describe('carrying answers over from an asset’s last visit', () => {
  async function publishForm() {
    const builder = await api.staff(owner);
    const as = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const response = await api.call(builder, {
        method,
        url,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      expect(response.statusCode, response.body).toBeLessThan(300);
      return json<T>(response);
    };
    const { form } = await as<{ form: { id: string } }>('POST', '/v1/forms', {
      title: `Chiller service ${tag()}`,
    });
    const detail = await as<{ draft: { revision: number } }>('GET', `/v1/forms/${form.id}`);
    const saved = await as<{ revision: number }>('PUT', `/v1/forms/${form.id}/draft`, {
      expectedRevision: detail.draft.revision,
      definition: {
        schemaVersion: 1,
        title: { en: 'Chiller service' },
        pages: [
          {
            id: 'page_1',
            sections: [
              {
                id: 'section_1',
                fields: [
                  {
                    id: 'refrigerant',
                    type: 'text',
                    label: { en: 'Refrigerant' },
                    carryOver: true,
                  },
                  {
                    id: 'charge',
                    type: 'decimal',
                    decimalPlaces: 2,
                    label: { en: 'Charge (kg)' },
                    carryOver: true,
                  },
                  { id: 'reading', type: 'text', label: { en: 'Today’s reading' } },
                ],
              },
            ],
          },
        ],
      },
    });
    await as('POST', `/v1/forms/${form.id}/draft/publish`, { expectedRevision: saved.revision });
    return form.id;
  }

  async function jobWithAssetAndForm(assetId: string, formId: string) {
    const job = await newJob();
    expect(
      (
        await call(dispatcher, 'POST', `/v1/work-orders/${job.id}/forms`, {
          formId,
          required: false,
        })
      ).statusCode,
    ).toBeLessThan(300);
    expect(
      (await call(dispatcher, 'POST', `/v1/work-orders/${job.id}/assets`, { assetId })).statusCode,
    ).toBeLessThan(300);
    return job;
  }

  interface Draft {
    submission: { id: string; revision: number; answers: Record<string, unknown> };
    asset: { id: string; reference: string } | null;
    carriedOver: { fromSubmissionId: string; fields: string[] } | null;
  }

  async function start(payload: Record<string, unknown>) {
    const response = await call(engineer, 'POST', '/v1/submissions', payload, randomUUID());
    return { response, draft: response.statusCode === 201 ? json<Draft>(response) : undefined };
  }

  it('fills only the marked questions from the same form’s last submission on the asset', async () => {
    const formId = await publishForm();
    const { asset } = await register({ name: 'Chiller' });
    const first = await jobWithAssetAndForm(asset.id, formId);

    const opened = await start({ formId, workOrderId: first.id, assetId: asset.id });
    expect(opened.response.statusCode, opened.response.body).toBe(201);
    expect(opened.draft).toMatchObject({
      asset: { id: asset.id, reference: asset.reference },
      carriedOver: null,
      submission: { answers: {} },
    });
    const answers = { refrigerant: 'R410A', charge: '2.40', reading: '7 bar' };
    const submitted = await call(
      engineer,
      'POST',
      `/v1/submissions/${opened.draft!.submission.id}/submit`,
      { answers, expectedRevision: opened.draft!.submission.revision },
    );
    expect(submitted.statusCode, submitted.body).toBe(200);

    const second = await jobWithAssetAndForm(asset.id, formId);
    const next = await start({ formId, workOrderId: second.id, assetId: asset.id });
    expect(next.draft).toMatchObject({
      submission: { answers: { refrigerant: 'R410A', charge: '2.40' } },
      carriedOver: {
        fromSubmissionId: opened.draft!.submission.id,
        fields: ['refrigerant', 'charge'],
      },
    });
    expect(next.draft!.submission.answers).not.toHaveProperty('reading');
    // Reading it back says the same, on any device.
    const read = json<Draft>(
      await call(engineer, 'GET', `/v1/submissions/${next.draft!.submission.id}`),
    );
    expect(read.carriedOver?.fields).toEqual(['refrigerant', 'charge']);

    // Started without the asset, nothing is carried.
    const plain = await start({ formId, workOrderId: second.id });
    expect(plain.draft).toMatchObject({
      asset: null,
      carriedOver: null,
      submission: { answers: {} },
    });

    // The phone is told what a form started for the asset would carry.
    const pulled = json<{
      assets: {
        asset: { id: string };
        carryOver: { formId: string; fields: string[]; answers: Record<string, unknown> }[];
      }[];
    }>(await call(engineer, 'GET', '/v1/sync/pull'));
    expect(pulled.assets.find((entry) => entry.asset.id === asset.id)?.carryOver).toEqual([
      expect.objectContaining({
        formId,
        fromSubmissionId: opened.draft!.submission.id,
        fields: ['refrigerant', 'charge'],
        answers: { refrigerant: 'R410A', charge: '2.40' },
      }),
    ]);
  });

  it('refuses an asset that is not one of the job’s, and a retired one', async () => {
    const formId = await publishForm();
    const { asset } = await register({ name: 'Linked chiller' });
    const job = await jobWithAssetAndForm(asset.id, formId);
    const loose = await register({ name: 'Unlinked chiller' });
    const notOnJob = await start({ formId, workOrderId: job.id, assetId: loose.asset.id });
    expect(notOnJob.response.statusCode).toBe(409);
    expect(code(notOnJob.response)).toBe('asset_not_on_work_order');

    const current = json<AssetDetail>(await call(dispatcher, 'GET', `/v1/assets/${asset.id}`));
    const retired = await call(dispatcher, 'POST', `/v1/assets/${asset.id}/status`, {
      status: 'retired',
      expectedVersion: current.asset.version,
    });
    expect(retired.statusCode, retired.body).toBe(200);
    const refused = await start({ formId, workOrderId: job.id, assetId: asset.id });
    expect(code(refused.response)).toBe('asset_retired');
  });

  it('starts a phone’s form for the asset, keeping it even if the asset moved off the job', async () => {
    const formId = await publishForm();
    const { asset } = await register({ name: 'Phone chiller' });
    const job = await jobWithAssetAndForm(asset.id, formId);
    const version = json<{ live: { id: string } }>(
      await call(engineer, 'GET', `/v1/forms/${formId}`),
    );
    const push = (mutations: Record<string, unknown>[]) =>
      call(engineer, 'POST', '/v1/sync/push', { sentAt: new Date().toISOString(), mutations });
    const startOnPhone = (assetId: string) => ({
      id: randomUUID(),
      entityId: randomUUID(),
      recordedAt: new Date().toISOString(),
      kind: 'submission.start',
      payload: {
        formId,
        formVersionId: version.live.id,
        workOrderId: job.id,
        assetId,
        carriedOver: { fromSubmissionId: randomUUID(), fields: ['refrigerant'] },
      },
    });
    const kept = startOnPhone(asset.id);
    expect(json<{ results: { outcome: string }[] }>(await push([kept])).results[0]).toMatchObject({
      outcome: 'applied',
    });
    expect(
      json<Draft>(await call(engineer, 'GET', `/v1/submissions/${kept.entityId}`)),
    ).toMatchObject({ asset: { id: asset.id }, carriedOver: { fields: ['refrigerant'] } });

    const elsewhere = await register({ name: 'Not on this job' });
    const dropped = startOnPhone(elsewhere.asset.id);
    expect(
      json<{ results: { outcome: string }[] }>(await push([dropped])).results[0],
    ).toMatchObject({
      outcome: 'applied',
    });
    expect(
      json<Draft>(await call(engineer, 'GET', `/v1/submissions/${dropped.entityId}`)),
    ).toMatchObject({ asset: null, carriedOver: null });
  });
});

describe('importing assets from CSV', () => {
  async function runImports() {
    const handlers = buildJobHandlers(api.services, api.config);
    const logger = createLogger({ level: 'error', write: () => undefined });
    for (;;) {
      const claimed = await getPlatformDataSource().jobs.claim({ workerId: 'test', limit: 50 });
      if (claimed.length === 0) {
        return;
      }
      for (const job of claimed.filter((candidate) => candidate.tenantId === api.tenantId)) {
        if (job.queue === 'import.run') {
          await handlers[job.queue]!(job.payload, {
            tenantId: job.tenantId,
            jobId: job.id,
            attempt: job.attempts,
            logger,
          });
        }
        await getPlatformDataSource().jobs.complete(job.id);
      }
    }
  }

  it('registers each good row with a number and a tag, and says why the others were refused', async () => {
    const serial = `IMP-${tag()}`;
    const existing = `IMP-${tag()}`;
    await register({ name: 'Already here', serialNumber: existing });
    const csv = [
      'customer_name,site_name,name,make,serial_number,install_date,warranty_expires_on,condition',
      `Riverside Housing,Block A,Imported chiller,Daikin,${serial},2021-05-01,2026-11-30,fair`,
      `Riverside Housing,Block Z,No such site,,,,,`,
      `Riverside Housing,Block A,Duplicate,,${existing},,,`,
      `Riverside Housing,Block A,Bad dates,,,2021-02-30,soon,broken`,
    ].join('\r\n');

    const refused = await call(dispatcher, 'POST', '/v1/imports', {
      kind: 'assets',
      fileName: 'assets.csv',
      csv,
    });
    expect(refused.statusCode).toBe(403);

    const started = await call(owner, 'POST', '/v1/imports', {
      kind: 'assets',
      fileName: 'assets.csv',
      csv,
    });
    expect(started.statusCode, started.body).toBe(202);
    await runImports();
    const report = json<{
      status: string;
      succeededRows: number;
      failedRows: number;
      errors: { row: number; column: string | null; code: string }[];
    }>(await call(owner, 'GET', `/v1/imports/${json<{ id: string }>(started).id}`));
    expect(report).toMatchObject({ status: 'completed', succeededRows: 1, failedRows: 3 });
    expect(report.errors.map((error) => [error.row, error.column, error.code])).toEqual([
      [3, 'site_name', 'not_found'],
      [4, 'serial_number', 'duplicate'],
      [5, 'install_date', 'invalid'],
      [5, 'warranty_expires_on', 'invalid'],
      [5, 'condition', 'invalid'],
    ]);

    const found = json<{ items: AssetBody[] }>(
      await call(dispatcher, 'GET', `/v1/assets?q=${encodeURIComponent(serial)}`),
    ).items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'Imported chiller',
      serialNumber: serial,
      condition: 'fair',
      site: { id: siteId },
    });
    expect(found[0]!.reference).toMatch(/^AS-\d{6}$/u);
    expect(found[0]!.tagCode).toHaveLength(12);

    const template = await call(owner, 'GET', '/v1/imports/templates/assets');
    expect(template.body.split('\r\n')[0]).toBe(
      'customer_account_number,customer_name,site_name,name,make,model,serial_number,location,install_date,warranty_expires_on,condition,notes',
    );
  });
});
