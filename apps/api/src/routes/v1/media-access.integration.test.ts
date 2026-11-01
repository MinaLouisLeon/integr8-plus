import { randomBytes, randomUUID } from 'node:crypto';
import { TEMPLATE_ASSET_ENTITY, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Who may read a stored file (docs/media): it follows the record that uses
 * it, kind by kind, and anyone else is told it does not exist — the same 404
 * as for an id nobody ever uploaded. An engineer still reads the files of the
 * jobs assigned to them, and of the assets at their sites, as the phone does.
 */

const WEB = 'https://app.test.integr8';

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let colleague: Member;
let viewer: Member;
let hr: Member;
const tokens = new Map<Member, string>();
const names = new Map<Member, string>();
let customerId: string;
let siteId: string;
let jobTypeId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(typeof who === 'string' ? who : await token(who), {
    method,
    url,
    headers: { 'idempotency-key': randomUUID() },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function upload(who: Member | string, contentType = 'image/jpeg', bytes?: Buffer) {
  const body = bytes ?? randomBytes(1_000);
  const created = await call(who, 'POST', '/v1/media', { contentType, byteSize: body.length });
  expect(created.statusCode, created.body).toBe(201);
  const { media, upload: target } = json<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(created);
  const url = new URL(target.url);
  const put = await api.app.inject({
    remoteAddress: api.remoteAddress,
    method: 'PUT',
    url: url.pathname + url.search,
    headers: target.headers,
    payload: body,
  });
  expect(put.statusCode, put.body).toBe(200);
  expect((await call(who, 'POST', `/v1/media/${media.id}/complete`)).statusCode).toBe(200);
  return media.id;
}

/** The status each reader gets for the file. */
async function readers(fileId: string, who: readonly Member[]) {
  const seen: Record<string, number> = {};
  for (const member of who) {
    seen[names.get(member)!] = (await call(member, 'GET', `/v1/media/${fileId}`)).statusCode;
  }
  return seen;
}

async function newJob(crew: readonly Member[]) {
  const response = await call(dispatcher, 'POST', '/v1/work-orders', {
    customerId,
    siteId,
    jobTypeId,
    crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ workOrder: { id: string } }>(response).workOrder.id;
}

async function attach(who: Member, owner: Record<string, string>, fileId: string) {
  const response = await call(who, 'POST', '/v1/attachments', {
    owner,
    fileId,
    title: 'File',
    kind: 'photo',
  });
  expect(response.statusCode, response.body).toBe(201);
}

let versionId: string;

async function submissionWith(
  by: Member,
  fileId: string,
  options: { draft?: boolean; assetId?: string } = {},
) {
  const answers = { photos: [{ mediaId: fileId, contentType: 'image/jpeg', byteSize: 1_000 }] };
  return withTenant(api.tenantId, async (tx) => {
    const draft = await tx.submissions.startDraft({
      formVersionId: versionId,
      submittedBy: by.userId,
      answers,
      ...(options.assetId === undefined ? {} : { assetId: options.assetId }),
    });
    if (options.draft === true) {
      return draft.id;
    }
    const done = await tx.submissions.submit(draft.id, answers, draft.revision, by.userId);
    expect(done.outcome).toBe('written');
    return draft.id;
  });
}

beforeAll(async () => {
  api = await startApi({ env: { WEB_APP_URL: WEB } });
  staff = await api.platformAdmin('ma-staff');
  const member = async (role: Member['role'], name: string) => {
    const made = await api.member(role, `ma-${name}`);
    names.set(made, name);
    return made;
  };
  owner = await member('owner', 'owner');
  dispatcher = await member('dispatcher', 'dispatcher');
  engineer = await member('engineer', 'engineer');
  colleague = await member('engineer', 'colleague');
  viewer = await member('viewer', 'viewer');
  hr = await member('hr_manager', 'hr');
  const type = await call(await api.staff(owner), 'POST', '/v1/job-types', {
    name: 'Boiler service',
    code: 'boiler',
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  const customer = await call(dispatcher, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  customerId = json<{ id: string }>(customer).id;
  const site = await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
    name: 'Block A',
    address: { line1: '1 River Road' },
  });
  siteId = json<{ id: string }>(site).id;
  versionId = await withTenant(api.tenantId, async (tx) => {
    const form = await tx.forms.createForm({ title: 'Visit', createdBy: owner.userId });
    const draft = await tx.forms.createDraft({
      formId: form.id,
      definition: {
        schemaVersion: 1,
        title: { en: 'Visit' },
        pages: [
          {
            id: 'page_1',
            sections: [
              {
                id: 'section_1',
                fields: [{ id: 'photos', type: 'photo', label: { en: 'Photos' } }],
              },
            ],
          },
        ],
      },
      createdBy: owner.userId,
    });
    return (await tx.forms.publishDraft(draft.id, owner.userId))!.id;
  });
});

afterAll(async () => {
  await api.close();
});

describe('a file nothing uses yet', () => {
  it('is its uploader’s alone, the owner included', async () => {
    const fileId = await upload(engineer);
    expect(await readers(fileId, [engineer, colleague, owner, viewer])).toEqual({
      engineer: 200,
      colleague: 404,
      owner: 404,
      viewer: 404,
    });
    // The refusal is the answer for an id nobody uploaded.
    const unknown = await call(owner, 'GET', `/v1/media/${randomUUID()}`);
    const refused = await call(owner, 'GET', `/v1/media/${fileId}`);
    expect(refused.statusCode).toBe(unknown.statusCode);
    expect(json<{ error: { code: string } }>(refused).error.code).toBe(
      json<{ error: { code: string } }>(unknown).error.code,
    );
  });
});

describe('a submission’s file', () => {
  it('is read by whoever may read the submission', async () => {
    const fileId = await upload(engineer);
    await submissionWith(engineer, fileId);
    expect(await readers(fileId, [engineer, colleague, dispatcher, viewer, hr])).toEqual({
      engineer: 200,
      colleague: 404,
      dispatcher: 200,
      viewer: 200,
      hr: 404,
    });
  });

  it('on a draft, only by the person filling it', async () => {
    const fileId = await upload(engineer);
    await submissionWith(engineer, fileId, { draft: true });
    expect(await readers(fileId, [engineer, dispatcher])).toEqual({
      engineer: 200,
      dispatcher: 404,
    });
  });
});

describe('a job’s file', () => {
  it('is read by the job’s crew and the office, not by another engineer', async () => {
    const jobId = await newJob([engineer]);
    const fileId = await upload(engineer);
    await attach(engineer, { workOrderId: jobId }, fileId);
    expect(await readers(fileId, [engineer, colleague, viewer, hr])).toEqual({
      engineer: 200,
      colleague: 404,
      viewer: 200,
      hr: 404,
    });
  });

  it('includes the customer’s signature on the sign-off', async () => {
    const jobId = await newJob([engineer]);
    const fileId = await upload(engineer, 'image/png');
    await withTenant(api.tenantId, (tx) =>
      tx.workOrders.signOff(
        jobId,
        { fileId, name: 'Mona Adel', role: null, signedAt: new Date() },
        engineer.userId,
      ),
    );
    expect(await readers(fileId, [engineer, colleague, dispatcher])).toEqual({
      engineer: 200,
      colleague: 404,
      dispatcher: 200,
    });
  });
});

describe('a customer’s or site’s file', () => {
  it('is read by whoever reads customers', async () => {
    const fileId = await upload(dispatcher);
    await attach(dispatcher, { siteId }, fileId);
    expect(await readers(fileId, [engineer, viewer, hr])).toEqual({
      engineer: 200,
      viewer: 200,
      hr: 404,
    });
  });
});

describe('an asset’s files', () => {
  it('follow the asset, with the photos of earlier visits for an engineer at the site', async () => {
    await setFlag('assets', true);
    const registered = await call(dispatcher, 'POST', '/v1/assets', { name: 'Boiler', siteId });
    expect(registered.statusCode, registered.body).toBe(201);
    const assetId = json<{ asset: { id: string } }>(registered).asset.id;

    const picture = await upload(dispatcher);
    await attach(dispatcher, { assetId }, picture);

    // The engineer's earlier visit to the boiler: a form filled for it with a
    // photo, and a photo on the job, whose only asset it is.
    const earlier = await newJob([engineer]);
    await withTenant(api.tenantId, (tx) => tx.assets.link(earlier, assetId, dispatcher.userId));
    const visitPhoto = await upload(engineer);
    await submissionWith(engineer, visitPhoto, { assetId });
    const jobPhoto = await upload(engineer);
    await attach(engineer, { workOrderId: earlier }, jobPhoto);

    // Before the colleague has any job at the site: nothing.
    expect(await readers(picture, [colleague])).toEqual({ colleague: 404 });
    expect(await readers(visitPhoto, [colleague])).toEqual({ colleague: 404 });

    // With a job there, the asset's history is theirs to read, photos included.
    await newJob([colleague]);
    expect(await readers(picture, [colleague, viewer, hr])).toEqual({
      colleague: 200,
      viewer: 200,
      hr: 404,
    });
    expect(await readers(visitPhoto, [colleague])).toEqual({ colleague: 200 });
    expect(await readers(jobPhoto, [colleague])).toEqual({ colleague: 200 });

    // Without the assets module the history is not shown, so neither are its files.
    await setFlag('assets', false);
    expect(await readers(picture, [colleague, viewer])).toEqual({ colleague: 404, viewer: 404 });
    expect(await readers(visitPhoto, [colleague])).toEqual({ colleague: 404 });
    await setFlag('assets', true);
  });
});

describe('an expense receipt', () => {
  it('is read by its claimant and the approvers only', async () => {
    await setFlag('hr', true);
    const category = await call(owner, 'POST', '/v1/expenses/categories', { name: 'Fuel' });
    expect(category.statusCode, category.body).toBe(201);
    const claim = await call(engineer, 'POST', '/v1/expenses', {
      categoryId: json<{ id: string }>(category).id,
      spentOn: new Date().toISOString().slice(0, 10),
      amount: '50',
      description: 'Fuel',
    });
    expect(claim.statusCode, claim.body).toBe(201);
    const fileId = await upload(engineer);
    await attach(engineer, { expenseClaimId: json<{ id: string }>(claim).id }, fileId);
    expect(await readers(fileId, [engineer, colleague, hr, owner, viewer, dispatcher])).toEqual({
      engineer: 200,
      colleague: 404,
      hr: 200,
      owner: 200,
      viewer: 404,
      dispatcher: 404,
    });
  });
});

describe('an item’s picture', () => {
  it('is read by whoever reads the catalogue', async () => {
    await setFlag('inventory', true);
    const fileId = await upload(dispatcher);
    await withTenant(api.tenantId, async (tx) => {
      const item = await tx.inventoryCatalogue.createItem(
        { sku: `VALVE-${randomUUID().slice(0, 6)}`, name: 'Valve' },
        dispatcher.userId,
      );
      await tx.attachments.add({ itemId: item.id }, { fileId, title: 'Valve' }, dispatcher.userId);
    });
    expect(await readers(fileId, [engineer, viewer, hr])).toEqual({
      engineer: 200,
      viewer: 200,
      hr: 404,
    });
  });
});

describe('a certificate’s scan', () => {
  it('is read by its holder and whoever reads qualifications', async () => {
    const fileId = await upload(hr);
    await withTenant(api.tenantId, async (tx) => {
      const type = await tx.qualifications.createType(
        { name: `Gas Safe ${randomUUID().slice(0, 4)}`, kind: 'certificate' },
        hr.userId,
      );
      if (type.outcome !== 'written') throw new Error(type.outcome);
      const record = await tx.qualifications.addRecord(
        { userId: engineer.userId, qualificationTypeId: type.type.id },
        hr.userId,
      );
      if (record.outcome !== 'written') throw new Error(record.outcome);
      await tx.attachments.add(
        { memberQualificationId: record.record.id },
        { fileId, title: 'Scan' },
        hr.userId,
      );
    });
    expect(await readers(fileId, [engineer, colleague, dispatcher, hr])).toEqual({
      engineer: 200,
      colleague: 404,
      dispatcher: 200,
      hr: 200,
    });
  });
});

describe('a document’s PDF and a template’s picture', () => {
  it('are read by document readers, and by Integr8 staff designing templates', async () => {
    await setFlag('documents', true);
    const pdf = await upload(owner, 'application/pdf', Buffer.from('%PDF-1.7\n%%EOF\n', 'latin1'));
    const made = await call(owner, 'POST', '/v1/documents', {
      fileId: pdf,
      title: 'Certificate',
      reference: 'C-1',
    });
    expect(made.statusCode, made.body).toBe(201);
    expect(await readers(pdf, [viewer, dispatcher, engineer, hr])).toEqual({
      viewer: 200,
      dispatcher: 200,
      engineer: 404,
      hr: 404,
    });

    const designer = await api.staff(owner);
    const background = await upload(designer, 'image/png');
    await withTenant(api.tenantId, (tx) =>
      tx.files.link(background, { type: TEMPLATE_ASSET_ENTITY, id: randomUUID() }),
    );
    expect((await call(designer, 'GET', `/v1/media/${background}`)).statusCode).toBe(200);
    expect(await readers(background, [owner, viewer])).toEqual({ owner: 404, viewer: 404 });
  });
});

describe('the company’s logo', () => {
  it('is read by every member', async () => {
    const logo = await upload(owner, 'image/png');
    const set = await call(await api.staff(owner), 'PATCH', '/v1/settings', {
      logoMediaId: logo,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(await readers(logo, [engineer, viewer, hr])).toEqual({
      engineer: 200,
      viewer: 200,
      hr: 200,
    });
  });
});
