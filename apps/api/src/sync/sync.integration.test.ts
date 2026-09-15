import { getPlatformDataSource, withTenant } from '@integr8/db';
import {
  compileDefinition,
  createFormState,
  type MediaReference,
  toSubmission,
  transition,
} from '@integr8/form-engine';
import {
  geoPointFrom,
  readDecimal,
  readInteger,
  toggleOption,
  withOffset,
} from '@integr8/form-input';
import {
  changesNeedingAttention,
  discardChange,
  job as localJob,
  localCompletion,
  jobSyncState,
  queueUpload,
  recordAccessChange,
  recordAnswers,
  recordChecklist,
  recordComment,
  recordFormStarted,
  recordPhoto,
  recordShiftEnd,
  recordShiftStart,
  recordSignoff,
  recordSubmit,
  recordTransition,
  resolveAccessConflict,
  resolveAnswersConflict,
  syncStatus,
} from '@integr8/offline';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type Member, startApi } from '../testing/api-harness.js';
import { openPhone, type Phone, SkewedClock } from '../testing/phone.js';

/**
 * Offline sync end to end (P12): the phone's own sync engine and database,
 * against the real API and PostgreSQL, over a network the tests break on
 * purpose.
 *
 * Each P12 exit criterion that can be proven off a device is proven here:
 *
 * - a full job done in aeroplane mode — answers, ten photos, two signatures —
 *   arrives complete when the signal returns;
 * - killing the app mid-upload and reopening it resumes, duplicating nothing;
 * - the same job changed on two devices offline gives a conflict someone can
 *   resolve, never a silent loss;
 * - sending the whole outbox again, twice, leaves the server exactly as it was;
 * - "safe to leave" is false until everything for the job has arrived.
 */

let api: ApiHarness;
let office: Member;
let engineer: Member;
let crewmate: Member;
let officeToken: string;
let ownerToken: string;
let formId: string;
let jobTypeId: string;
let customerId: string;
let siteId: string;
const scratch = mkdtempSync(join(tmpdir(), 'integr8-sync-'));

async function call<T>(
  token: string,
  method: string,
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await api.call(token, {
    method: method as 'GET',
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return (response.body === '' ? undefined : JSON.parse(response.body)) as T;
}

interface Detail {
  workOrder: { id: string; state: string; revision: number };
  site: { access: { gateCode: string | null } };
  checklist: { id: string; done: boolean }[];
  comments: { id: string; body: string }[];
}

async function newJob(crew: Member[], state: 'scheduled' | 'dispatched' = 'dispatched') {
  let detail = await call<Detail>(
    officeToken,
    'POST',
    '/v1/work-orders',
    {
      customerId,
      siteId,
      jobTypeId,
      crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
    },
    201,
  );
  if (state === 'dispatched') {
    detail = await call<Detail>(
      officeToken,
      'POST',
      `/v1/work-orders/${detail.workOrder.id}/transitions`,
      {
        to: 'dispatched',
        expectedRevision: detail.workOrder.revision,
      },
    );
  }
  return detail;
}

const serverJob = (id: string) => call<Detail>(officeToken, 'GET', `/v1/work-orders/${id}`);

function file(name: string, bytes: number) {
  const path = join(scratch, `${name}-${randomBytes(4).toString('hex')}`);
  writeFileSync(path, randomBytes(bytes));
  return path;
}

async function photo(
  phone: Phone,
  workOrderId: string,
  contentType = 'image/jpeg',
  bytes = 150_000,
) {
  const path = file('photo', bytes);
  const mediaId = await queueUpload(phone.context, {
    localPath: path,
    contentType,
    byteSize: bytes,
    workOrderId,
  });
  return { mediaId, contentType, byteSize: bytes };
}

const today = (clock: { now(): Date }) => clock.now().toISOString().slice(0, 10);

async function liveVersion(phone: Phone) {
  const row = await phone.db.read((sql) =>
    sql.get<{ live_version_id: string }>('select live_version_id from forms where id = ?', [
      formId,
    ]),
  );
  return row!.live_version_id;
}

beforeAll(async () => {
  // Every phone here, and the office, reaches the API from one address.
  api = await startApi({ env: { API_IP_RATE_LIMIT: '5000' } });
  office = await api.member('dispatcher', 'office');
  engineer = await api.member('engineer', 'ed');
  crewmate = await api.member('engineer', 'cara');
  officeToken = await api.signIn(await api.member('owner', 'owner'));
  const dispatcherToken = await api.signIn(office);

  const { form } = await call<{ form: { id: string } }>(
    officeToken,
    'POST',
    '/v1/forms',
    { title: 'Gas safety' },
    201,
  );
  formId = form.id;
  const detail = await call<{ draft: { revision: number } }>(
    officeToken,
    'GET',
    `/v1/forms/${formId}`,
  );
  const saved = await call<{ revision: number }>(officeToken, 'PUT', `/v1/forms/${formId}/draft`, {
    expectedRevision: detail.draft.revision,
    definition: {
      schemaVersion: 1,
      title: { en: 'Gas safety' },
      pages: [
        {
          id: 'page_1',
          sections: [
            {
              id: 'section_1',
              fields: [
                { id: 'note', type: 'text', label: { en: 'Note' }, required: true },
                { id: 'pressure', type: 'number', label: { en: 'Pressure' } },
                { id: 'customer_name', type: 'text', label: { en: 'Customer name' } },
                { id: 'photos', type: 'photo', label: { en: 'Photos' }, maxFiles: 10 },
                {
                  id: 'engineer_signature',
                  type: 'signature',
                  label: { en: 'Engineer' },
                  required: true,
                },
                {
                  id: 'customer_signature',
                  type: 'signature',
                  label: { en: 'Customer' },
                  required: true,
                },
              ],
            },
          ],
        },
      ],
    },
  });
  await call(officeToken, 'POST', `/v1/forms/${formId}/draft/publish`, {
    expectedRevision: saved.revision,
  });

  jobTypeId = (
    await call<{ id: string }>(
      officeToken,
      'POST',
      '/v1/job-types',
      {
        name: 'Boiler service',
        code: 'boiler-service',
        checklist: [{ label: 'Isolate supply' }, { label: 'Inspect flue' }],
        forms: [{ formId, required: true }],
      },
      201,
    )
  ).id;
  customerId = (
    await call<{ id: string }>(
      dispatcherToken,
      'POST',
      '/v1/customers',
      { name: 'Riverside Housing' },
      201,
    )
  ).id;
  siteId = (
    await call<{ id: string }>(
      dispatcherToken,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Block A', address: { line1: '1 River Road' }, access: { gateCode: '4471#' } },
      201,
    )
  ).id;
  ownerToken = officeToken;
  officeToken = dispatcherToken;
});

afterAll(async () => {
  await api.close();
});

describe('a full job in aeroplane mode', () => {
  it('arrives complete when the signal returns — answers, ten photos, two signatures — and only then is it safe to leave', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    expect((await phone.sync()).outcome).toBe('complete');
    expect(await phone.db.read((sql) => localJob(sql, job.workOrder.id))).toBeDefined();

    // In the plant room, with no signal.
    phone.network.online = false;
    const id = job.workOrder.id;
    await recordTransition(phone.context, { workOrderId: id, to: 'on_site' });
    await recordTransition(phone.context, { workOrderId: id, to: 'in_progress' });
    for (const item of job.checklist) {
      await recordChecklist(phone.context, { workOrderId: id, itemId: item.id, done: true });
    }
    const { submissionId } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: await liveVersion(phone),
      workOrderId: id,
    });
    const photos = [];
    for (let index = 0; index < 10; index += 1) {
      photos.push(await photo(phone, id));
    }
    const engineerSignature = await photo(phone, id, 'image/png', 20_000);
    const customerSignature = await photo(phone, id, 'image/png', 20_000);
    await recordAnswers(phone.context, {
      submissionId,
      answers: { note: 'Flue checked', photos: photos.slice(0, 4) },
    });
    const answers = {
      note: 'Flue checked; working pressure 20 mbar',
      pressure: 20,
      photos,
      engineer_signature: engineerSignature,
      customer_signature: customerSignature,
    };
    await recordSubmit(phone.context, { submissionId, answers, filledOn: today(phone.clock) });
    await recordComment(phone.context, {
      workOrderId: id,
      body: 'Customer happy',
      visibility: 'internal',
    });
    await recordTransition(phone.context, { workOrderId: id, to: 'complete' });

    // The phone shows the work done, and says it is not yet safe to leave.
    expect((await phone.db.read((sql) => localJob(sql, id)))?.detail.workOrder.state).toBe(
      'complete',
    );
    const before = await phone.db.read((sql) => jobSyncState(sql, id));
    expect(before).toMatchObject({ safeToLeave: false, pendingUploads: 12 });
    expect(before.pendingChanges).toBeGreaterThan(0);
    expect((await phone.sync()).outcome).toBe('offline');
    expect((await serverJob(id)).workOrder.state).toBe('dispatched');

    // Back in the van.
    phone.network.online = true;
    const run = await phone.sync('reconnect');
    expect(run).toMatchObject({
      outcome: 'complete',
      uploadsCompleted: 12,
      conflicts: 0,
      rejected: 0,
    });

    const server = await serverJob(id);
    expect(server.workOrder.state).toBe('complete');
    expect(server.checklist.every((item) => item.done)).toBe(true);
    expect(server.comments.map((comment) => comment.body)).toContain('Customer happy');
    const submission = await call<{ submission: { status: string; answers: typeof answers } }>(
      officeToken,
      'GET',
      `/v1/submissions/${submissionId}`,
    );
    expect(submission.submission.status).toBe('submitted');
    expect(submission.submission.answers.photos).toHaveLength(10);
    expect(submission.submission.answers.customer_signature.mediaId).toBe(
      customerSignature.mediaId,
    );
    for (const media of [...photos, engineerSignature, customerSignature]) {
      const stored = await call<{ status: string; byteSize: number }>(
        officeToken,
        'GET',
        `/v1/media/${media.mediaId}`,
      );
      expect(stored).toMatchObject({ status: 'stored', byteSize: media.byteSize });
    }

    expect(await phone.db.read((sql) => jobSyncState(sql, id))).toEqual({
      safeToLeave: true,
      pendingChanges: 0,
      pendingUploads: 0,
      needsAttention: 0,
    });
    expect(await phone.db.read(syncStatus)).toMatchObject({
      pendingChanges: 0,
      pendingUploads: 0,
      conflicts: 0,
    });

    // And the server has the phone's account of how it went.
    const reports = await withTenant(api.tenantId, (tx) =>
      tx.sync.listReports({ userId: engineer.userId }),
    );
    expect(reports.map((report) => report.outcome)).toContain('complete');
    expect(reports.find((report) => report.outcome === 'complete')).toMatchObject({
      uploads_completed: 12,
    });
  });
});

describe('killing the app', () => {
  it('resumes a large upload and a lost reply without sending anything twice', async () => {
    const job = await newJob([engineer]);
    let phone = await openPhone(api, engineer);
    await phone.sync();
    phone.network.online = false;
    const size = 20 * 1024 * 1024;
    const path = file('video', size);
    const mediaId = await queueUpload(phone.context, {
      localPath: path,
      contentType: 'video/mp4',
      byteSize: size,
      workOrderId: job.workOrder.id,
    });
    await recordComment(phone.context, {
      workOrderId: job.workOrder.id,
      body: 'Recorded the fault',
      visibility: 'internal',
    });
    phone.network.online = true;

    // The server applies the change, but its answer never reaches the phone.
    phone.network.lose((method, path) => method === 'POST' && path === '/v1/sync/push', {
      stage: 'after',
    });
    expect((await phone.sync()).outcome).toBe('offline');

    // The comment arrives; part 2 of the video reaches storage, and the phone dies before hearing so.
    const partPath = (number: number) =>
      new RegExp(`^/local-media-parts/.+/${String(number)}$`, 'u');
    phone.network.lose((method, path) => method === 'PUT' && partPath(2).test(path), {
      stage: 'after',
    });
    await phone.sync();
    expect(
      await phone.db.read((sql) =>
        sql.get('select parts_done, state from uploads where media_id = ?', [mediaId]),
      ),
    ).toEqual({
      parts_done: '[1]',
      state: 'queued',
    });

    phone = await phone.kill();
    expect((await phone.sync()).outcome).toBe('complete');

    expect(phone.network.count('PUT', partPath(1))).toBe(1);
    expect(phone.network.count('PUT', partPath(2))).toBe(1);
    expect(phone.network.count('PUT', partPath(3))).toBe(1);
    expect(await call(officeToken, 'GET', `/v1/media/${mediaId}`)).toMatchObject({
      status: 'stored',
      byteSize: size,
    });
    const comments = (await serverJob(job.workOrder.id)).comments.filter(
      (comment) => comment.body === 'Recorded the fault',
    );
    expect(comments).toHaveLength(1);
    expect(await phone.db.read((sql) => jobSyncState(sql, job.workOrder.id))).toMatchObject({
      safeToLeave: true,
    });
  });
});

describe('the same job changed on two devices offline', () => {
  it('turns different access notes into a conflict the second engineer resolves, and nothing is lost', async () => {
    const job = await newJob([engineer, crewmate]);
    const ed = await openPhone(api, engineer);
    const cara = await openPhone(api, crewmate);
    await ed.sync();
    await cara.sync();
    ed.network.online = false;
    cara.network.online = false;
    await recordAccessChange(ed.context, { siteId, changes: { gateCode: '1111#' } });
    await recordAccessChange(cara.context, {
      siteId,
      changes: { gateCode: '2222#', parking: 'Rear bays' },
    });

    ed.network.online = true;
    expect((await ed.sync()).outcome).toBe('complete');
    cara.network.online = true;
    expect(await cara.sync()).toMatchObject({ conflicts: 1 });

    const [conflict] = await cara.db.read(changesNeedingAttention);
    expect(conflict?.conflict).toMatchObject({
      kind: 'access_changed',
      fields: [{ field: 'gateCode', base: '4471#', mine: '2222#', theirs: '1111#' }],
    });
    expect((await cara.db.read((sql) => jobSyncState(sql, job.workOrder.id))).safeToLeave).toBe(
      false,
    );
    // Nothing written while it is undecided: parking waits with the gate code.
    expect((await serverJob(job.workOrder.id)).site.access.gateCode).toBe('1111#');

    await resolveAccessConflict(cara.context, conflict!.id, { gateCode: 'mine' });
    expect((await cara.sync()).outcome).toBe('complete');
    const site = await call<{ site: { access: { gateCode: string; parking: string } } }>(
      officeToken,
      'GET',
      `/v1/sites/${siteId}`,
    );
    expect(site.site.access).toMatchObject({ gateCode: '2222#', parking: 'Rear bays' });
  });

  it('shows a job moved on elsewhere as a conflict, and keeping theirs leaves the phone showing theirs', async () => {
    const job = await newJob([engineer, crewmate]);
    const ed = await openPhone(api, engineer);
    const cara = await openPhone(api, crewmate);
    await ed.sync();
    await cara.sync();
    ed.network.online = false;
    cara.network.online = false;
    await recordTransition(ed.context, { workOrderId: job.workOrder.id, to: 'on_site' });
    await recordTransition(cara.context, { workOrderId: job.workOrder.id, to: 'travelling' });

    ed.network.online = true;
    await ed.sync();
    cara.network.online = true;
    await cara.sync();
    const [conflict] = await cara.db.read(changesNeedingAttention);
    expect(conflict?.conflict).toMatchObject({
      kind: 'state_changed',
      current: { state: 'on_site', changedBy: { name: 'ed' } },
      canReapply: true,
    });

    await discardChange(cara.context, conflict!.id);
    await cara.sync();
    expect(
      (await cara.db.read((sql) => localJob(sql, job.workOrder.id)))?.detail.workOrder.state,
    ).toBe('on_site');
    expect((await serverJob(job.workOrder.id)).workOrder.state).toBe('on_site');
  });

  it('never completes a job the office cancelled while the engineer worked offline, and says so', async () => {
    const job = await newJob([engineer]);
    const ed = await openPhone(api, engineer);
    await ed.sync();
    ed.network.online = false;
    await recordTransition(ed.context, { workOrderId: job.workOrder.id, to: 'on_site' });
    const latest = await serverJob(job.workOrder.id);
    await call(officeToken, 'POST', `/v1/work-orders/${job.workOrder.id}/transitions`, {
      to: 'cancelled',
      expectedRevision: latest.workOrder.revision,
      reason: 'Customer rang to cancel',
    });

    ed.network.online = true;
    await ed.sync();
    expect((await serverJob(job.workOrder.id)).workOrder.state).toBe('cancelled');
    const [conflict] = await ed.db.read(changesNeedingAttention);
    expect(conflict?.conflict).toMatchObject({
      kind: 'state_changed',
      current: { state: 'cancelled', reason: 'Customer rang to cancel' },
    });
  });

  it('merges answers changed on two devices, and asks only about the question both changed', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    const tablet = await openPhone(api, engineer);
    await phone.sync();
    const { submissionId } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: await liveVersion(phone),
      workOrderId: job.workOrder.id,
    });
    await recordAnswers(phone.context, { submissionId, answers: { note: 'Started' } });
    await phone.sync();
    await tablet.sync();
    expect(
      await tablet.db.read((sql) =>
        sql.get('select server_revision, answers from submissions where id = ?', [submissionId]),
      ),
    ).toMatchObject({ answers: '{"note":"Started"}' });

    phone.network.online = false;
    tablet.network.online = false;
    await recordAnswers(phone.context, {
      submissionId,
      answers: { note: 'Boiler fine', pressure: 18 },
    });
    await recordAnswers(tablet.context, {
      submissionId,
      answers: { note: 'Needs a part', customer_name: 'Pat' },
    });

    phone.network.online = true;
    await phone.sync();
    tablet.network.online = true;
    await tablet.sync();
    const [conflict] = await tablet.db.read(changesNeedingAttention);
    expect(conflict?.conflict).toMatchObject({
      kind: 'answers_changed',
      questions: [{ id: 'note', base: 'Started', mine: 'Needs a part', theirs: 'Boiler fine' }],
    });

    await resolveAnswersConflict(tablet.context, conflict!.id, { note: 'mine' });
    expect((await tablet.sync()).outcome).toBe('complete');
    // A draft is its author's alone, so read it as the engineer.
    const stored = await call<{ submission: { answers: Record<string, unknown> } }>(
      await api.signIn(engineer),
      'GET',
      `/v1/submissions/${submissionId}`,
    );
    expect(stored.submission.answers).toEqual({
      note: 'Needs a part',
      pressure: 18,
      customer_name: 'Pat',
    });
  });
});

describe('replaying the outbox', () => {
  it('sends every change again, twice, and the server ends exactly as it was', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    const id = job.workOrder.id;
    await recordTransition(phone.context, { workOrderId: id, to: 'on_site' });
    await recordTransition(phone.context, { workOrderId: id, to: 'in_progress' });
    await recordChecklist(phone.context, {
      workOrderId: id,
      itemId: job.checklist[0]!.id,
      done: true,
    });
    await recordComment(phone.context, {
      workOrderId: id,
      body: 'Replayed?',
      visibility: 'internal',
    });
    const { submissionId } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: await liveVersion(phone),
      workOrderId: id,
    });
    const signature = await photo(phone, id, 'image/png', 10_000);
    await recordSubmit(phone.context, {
      submissionId,
      answers: { note: 'Once', engineer_signature: signature, customer_signature: signature },
      filledOn: today(phone.clock),
    });
    await recordTransition(phone.context, { workOrderId: id, to: 'complete' });
    expect((await phone.sync()).outcome).toBe('complete');

    const snapshot = async () => {
      const detail = await call<Record<string, unknown>>(
        officeToken,
        'GET',
        `/v1/work-orders/${id}`,
      );
      const submissions = await call<{ items: { id: string; revision: number; status: string }[] }>(
        officeToken,
        'GET',
        `/v1/submissions?workOrderId=${id}`,
      );
      const events = await withTenant(api.tenantId, (tx) => tx.workOrders.listEvents(id));
      return { detail, submissions: submissions.items, events: events.length };
    };
    const before = await snapshot();

    for (let replay = 0; replay < 2; replay += 1) {
      await phone.db.write(['outbox'], (sql) =>
        sql.run(`update outbox set state = 'pending', attempts = 0, next_attempt_at = null`),
      );
      const run = await phone.sync();
      expect(run).toMatchObject({ outcome: 'complete', conflicts: 0, rejected: 0 });
      expect(run.pushed).toBe(7);
    }

    expect(await snapshot()).toEqual(before);
  });

  it('refuses a change id reused for a different change', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    await recordComment(phone.context, {
      workOrderId: job.workOrder.id,
      body: 'First',
      visibility: 'internal',
    });
    await phone.sync();
    await phone.db.write(['outbox'], (sql) =>
      sql.run(
        `update outbox set state = 'pending', payload = json_set(payload, '$.body', 'Tampered')`,
      ),
    );
    expect(await phone.sync()).toMatchObject({ rejected: 1 });
    const [refused] = await phone.db.read(changesNeedingAttention);
    expect(refused?.lastError?.code).toBe('mutation_id_reused');
  });

  it('sends the rest when the server cannot read one change, and shows that one to the engineer', async () => {
    const first = await newJob([engineer]);
    const second = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    await recordComment(phone.context, {
      workOrderId: first.workOrder.id,
      body: 'x'.repeat(10_001),
      visibility: 'internal',
    });
    await recordChecklist(phone.context, {
      workOrderId: second.workOrder.id,
      itemId: second.checklist[0]!.id,
      done: true,
    });

    expect(await phone.sync()).toMatchObject({ pushed: 1, rejected: 1 });
    const [refused] = await phone.db.read(changesNeedingAttention);
    expect(refused).toMatchObject({
      kind: 'work_order.comment',
      lastError: { code: 'unreadable_change' },
    });
    const detail = await call<{ checklist: { id: string; done: boolean }[] }>(
      officeToken,
      'GET',
      `/v1/work-orders/${second.workOrder.id}`,
    );
    expect(detail.checklist[0]?.done).toBe(true);
  });
});

describe('the same form on the phone and on the desktop (P13)', () => {
  const opt = (...values: string[]) => values.map((value) => ({ value, label: { en: value } }));
  /** Every field type in the registry, and one worked out from another. */
  const everyType = {
    schemaVersion: 1,
    title: { en: 'Every question' },
    pages: [
      {
        id: 'page_1',
        sections: [
          {
            id: 'section_1',
            fields: [
              { id: 'make', type: 'text', label: { en: 'Make' } },
              { id: 'notes', type: 'long_text', label: { en: 'Notes' } },
              { id: 'serial', type: 'barcode', label: { en: 'Serial' } },
              { id: 'visits', type: 'number', label: { en: 'Visits' } },
              {
                id: 'visits_doubled',
                type: 'number',
                label: { en: 'Doubled' },
                calculation: {
                  kind: 'arithmetic',
                  operator: 'multiply',
                  left: { kind: 'answer', field: 'visits' },
                  right: { kind: 'number', value: '2' },
                },
              },
              { id: 'pressure', type: 'decimal', decimalPlaces: 2, label: { en: 'Pressure' } },
              { id: 'condition', type: 'rating', scale: 5, label: { en: 'Condition' } },
              { id: 'installed', type: 'date', label: { en: 'Installed' } },
              { id: 'arrived', type: 'time', label: { en: 'Arrived' } },
              { id: 'finished', type: 'datetime', label: { en: 'Finished' } },
              { id: 'fuel', type: 'dropdown', options: opt('gas', 'oil'), label: { en: 'Fuel' } },
              { id: 'room', type: 'radio', options: opt('kitchen', 'loft'), label: { en: 'Room' } },
              {
                id: 'checked',
                type: 'multi_select',
                options: opt('flue', 'seals', 'fan'),
                label: { en: 'Checked' },
              },
              { id: 'isolated', type: 'checkbox', label: { en: 'Isolated' } },
              { id: 'safe', type: 'yes_no', allowNotApplicable: true, label: { en: 'Safe' } },
              { id: 'signed', type: 'signature', label: { en: 'Signed' } },
              { id: 'photos', type: 'photo', label: { en: 'Photos' } },
              {
                id: 'certificate',
                type: 'file',
                acceptedTypes: ['application/pdf'],
                label: { en: 'Certificate' },
              },
              { id: 'where', type: 'gps', label: { en: 'Where' } },
            ],
          },
        ],
      },
    ],
  };

  /**
   * What the controls give, the way both renderers turn touches into answers —
   * through `@integr8/form-input` — then what the engine says to submit.
   */
  function filled(media: {
    signature: MediaReference;
    photos: MediaReference[];
    certificate: MediaReference;
  }) {
    const compiled = compileDefinition(everyType);
    if (!compiled.ok) {
      throw new Error(JSON.stringify(compiled.issues));
    }
    const form = compiled.form;
    const raw: Record<string, unknown> = {
      make: 'Worcester',
      notes: 'Flue terminal clear\nSeals replaced',
      serial: 'GC-47-406-12',
      visits: readInteger('٣').answer,
      pressure: readDecimal('١٫٥٠'),
      condition: 4,
      installed: '2019-03-02',
      arrived: '08:30',
      finished: withOffset('2026-09-15T10:45', 180),
      fuel: 'gas',
      room: 'loft',
      checked: toggleOption(opt('flue', 'seals', 'fan'), ['fan'], 'flue', true),
      isolated: true,
      safe: 'not_applicable',
      signed: media.signature,
      photos: media.photos,
      certificate: [media.certificate],
      where: geoPointFrom({ latitude: 53.80071234, longitude: -1.5491, accuracy: 6.04 }),
    };
    let state = createFormState(form);
    for (const [field, value] of Object.entries(raw)) {
      const step = transition(form, state, { type: 'answer', field, value });
      expect(step.accepted, field).toBe(true);
      state = step.state;
    }
    return toSubmission(form, state, { today: '2026-09-15' });
  }

  it('stores identical answers, whichever filled it', async () => {
    const formId = (
      await call<{ form: { id: string } }>(
        ownerToken,
        'POST',
        '/v1/forms',
        { title: 'Every question' },
        201,
      )
    ).form.id;
    const draft = await call<{ draft: { revision: number } }>(
      ownerToken,
      'GET',
      `/v1/forms/${formId}`,
    );
    const saved = await call<{ revision: number }>(ownerToken, 'PUT', `/v1/forms/${formId}/draft`, {
      expectedRevision: draft.draft.revision,
      definition: everyType,
    });
    await call(ownerToken, 'POST', `/v1/forms/${formId}/draft/publish`, {
      expectedRevision: saved.revision,
    });
    const typeId = (
      await call<{ id: string }>(
        ownerToken,
        'POST',
        '/v1/job-types',
        { name: 'Every question', code: 'every-question', forms: [{ formId, required: false }] },
        201,
      )
    ).id;
    const jobOn = async () => {
      const created = await call<Detail>(
        officeToken,
        'POST',
        '/v1/work-orders',
        { customerId, siteId, jobTypeId: typeId, crew: [{ userId: engineer.userId, lead: true }] },
        201,
      );
      return call<Detail>(
        officeToken,
        'POST',
        `/v1/work-orders/${created.workOrder.id}/transitions`,
        {
          to: 'dispatched',
          expectedRevision: created.workOrder.revision,
        },
      );
    };
    const onPhone = await jobOn();
    const onDesktop = await jobOn();

    // The phone: offline, through the outbox.
    const phone = await openPhone(api, engineer);
    await phone.sync();
    const version = await phone.db.read((sql) =>
      sql.get<{ live_version_id: string }>('select live_version_id from forms where id = ?', [
        formId,
      ]),
    );
    const { submissionId: phoneSubmission } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: version!.live_version_id,
      workOrderId: onPhone.workOrder.id,
    });
    const signature = await photo(phone, onPhone.workOrder.id, 'image/png', 8_000);
    const photos = [
      await photo(phone, onPhone.workOrder.id),
      await photo(phone, onPhone.workOrder.id),
    ];
    const certificate = await photo(phone, onPhone.workOrder.id, 'application/pdf', 30_000);
    const phoneAnswers = filled({ signature, photos, certificate });
    await recordSubmit(phone.context, {
      submissionId: phoneSubmission,
      answers: phoneAnswers,
      filledOn: '2026-09-15',
      location: { status: 'denied' },
    });
    expect((await phone.sync()).outcome).toBe('complete');

    // The desktop: online, through the REST API the web and desktop apps use.
    const engineerToken = await api.signIn(engineer);
    const started = await call<{ submission: { id: string; revision: number } }>(
      engineerToken,
      'POST',
      '/v1/submissions',
      { formId, workOrderId: onDesktop.workOrder.id },
      201,
    );
    const uploadRest = async (bytes: number, contentType: string): Promise<MediaReference> => {
      const created = await call<{
        media: { id: string };
        upload: { url: string; headers: Record<string, string> };
      }>(engineerToken, 'POST', '/v1/media', { contentType, byteSize: bytes }, 201);
      const target = new URL(created.upload.url);
      const put = await api.app.inject({
        remoteAddress: api.remoteAddress,
        method: 'PUT',
        url: target.pathname + target.search,
        headers: created.upload.headers,
        payload: randomBytes(bytes),
      });
      expect(put.statusCode, put.body).toBe(200);
      await call(engineerToken, 'POST', `/v1/media/${created.media.id}/complete`);
      return { mediaId: created.media.id, contentType, byteSize: bytes };
    };
    const desktopAnswers = filled({
      signature: await uploadRest(8_000, 'image/png'),
      photos: [await uploadRest(150_000, 'image/jpeg'), await uploadRest(150_000, 'image/jpeg')],
      certificate: await uploadRest(30_000, 'application/pdf'),
    });
    await call(engineerToken, 'POST', `/v1/submissions/${started.submission.id}/submit`, {
      answers: desktopAnswers,
      expectedRevision: started.submission.revision,
      today: '2026-09-15',
    });

    const stored = async (id: string) => {
      const detail = await call<{
        submission: { status: string; answers: Record<string, unknown>; submitLocation: unknown };
        events: { location: unknown }[];
      }>(officeToken, 'GET', `/v1/submissions/${id}`);
      locations.set(id, [
        detail.submission.submitLocation,
        detail.events.map((event) => event.location),
      ]);
      // Two files are never the same file: compare what the answers say about them.
      const withoutIds = JSON.parse(
        JSON.stringify(detail.submission.answers).replace(
          /"mediaId":"[0-9a-f-]{36}"/gu,
          '"mediaId":"…"',
        ),
      ) as Record<string, unknown>;
      return { status: detail.submission.status, answers: withoutIds };
    };
    const locations = new Map<string, unknown>();
    const fromPhone = await stored(phoneSubmission);
    expect(fromPhone).toEqual(await stored(started.submission.id));
    // Only the phone says where it was.
    expect(locations.get(phoneSubmission)).toEqual([{ status: 'denied' }, [{ status: 'denied' }]]);
    expect(locations.get(started.submission.id)).toEqual([null, [null]]);
    expect(fromPhone.answers).toMatchObject({
      visits: 3,
      visits_doubled: 6,
      pressure: '1.50',
      finished: '2026-09-15T10:45:00+03:00',
      checked: ['flue', 'fan'],
      where: { latitude: '53.800712', longitude: '-1.549100', accuracyMeters: '6.0' },
    });
  });
});

describe('a working day on the phone (P14)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const upload = async (token: string, contentType: string, bytes: number) => {
    const created = await call<{
      media: { id: string };
      upload: { url: string; headers: Record<string, string> };
    }>(token, 'POST', '/v1/media', { contentType, byteSize: bytes }, 201);
    const target = new URL(created.upload.url);
    const put = await api.app.inject({
      remoteAddress: api.remoteAddress,
      method: 'PUT',
      url: target.pathname + target.search,
      headers: created.upload.headers,
      payload: randomBytes(bytes),
    });
    expect(put.statusCode, put.body).toBe(200);
    await call(token, 'POST', `/v1/media/${created.media.id}/complete`);
    return created.media.id;
  };

  it('arrives with its photos, sign-off, form and times intact, and the site plan was on the phone', async () => {
    const typeId = (
      await call<{ id: string }>(
        ownerToken,
        'POST',
        '/v1/job-types',
        {
          name: 'Boiler repair',
          code: 'boiler-repair',
          forms: [{ formId, required: true }],
          beforePhotos: 1,
          afterPhotos: 2,
          signatureRequired: true,
        },
        201,
      )
    ).id;
    const created = await call<Detail>(
      officeToken,
      'POST',
      '/v1/work-orders',
      { customerId, siteId, jobTypeId: typeId, crew: [{ userId: engineer.userId, lead: true }] },
      201,
    );
    const id = created.workOrder.id;
    await call(officeToken, 'POST', `/v1/work-orders/${id}/transitions`, {
      to: 'dispatched',
      expectedRevision: created.workOrder.revision,
    });
    const plan = await upload(officeToken, 'application/pdf', 40_000);
    await call(
      officeToken,
      'POST',
      '/v1/attachments',
      { owner: { workOrderId: id }, fileId: plan, title: 'Site plan', kind: 'site_plan' },
      201,
    );

    const phone = await openPhone(api, engineer);
    expect(await phone.sync()).toMatchObject({ outcome: 'complete', downloaded: 1 });
    expect((await stat(join(dirname(phone.path), 'files', 'attachments', plan))).size).toBe(40_000);

    // The whole day with no signal.
    phone.network.online = false;
    const shiftId = await recordShiftStart(phone.context, { location: { status: 'unavailable' } });
    await pause(150);
    await recordTransition(phone.context, { workOrderId: id, to: 'travelling' });
    await pause(300);
    await recordTransition(phone.context, { workOrderId: id, to: 'on_site' });
    await recordPhoto(phone.context, {
      workOrderId: id,
      stage: 'before',
      file: { localPath: file('before', 90_000), contentType: 'image/jpeg', byteSize: 90_000 },
    });
    await pause(100);
    await recordTransition(phone.context, { workOrderId: id, to: 'in_progress' });
    const { submissionId } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: await liveVersion(phone),
      workOrderId: id,
    });
    const signature = await photo(phone, id, 'image/png', 12_000);
    await recordSubmit(phone.context, {
      submissionId,
      answers: {
        note: 'Replaced the fan',
        engineer_signature: signature,
        customer_signature: signature,
      },
      filledOn: today(phone.clock),
    });
    for (const name of ['after-1', 'after-2']) {
      await recordPhoto(phone.context, {
        workOrderId: id,
        stage: 'after',
        file: { localPath: file(name, 80_000), contentType: 'image/jpeg', byteSize: 80_000 },
      });
    }
    // Nothing missing but the sign-off, as the phone sees it.
    expect((await phone.db.read((sql) => localCompletion(sql, id)))?.missing).toEqual({
      forms: [],
      beforePhotos: 0,
      afterPhotos: 0,
      signoff: true,
    });
    await recordSignoff(phone.context, {
      workOrderId: id,
      signoff: {
        signature: {
          localPath: file('customer', 15_000),
          contentType: 'image/png',
          byteSize: 15_000,
        },
        name: 'Mrs Patel',
        role: 'Tenant',
      },
    });
    await pause(200);
    await recordTransition(phone.context, { workOrderId: id, to: 'complete' });
    await recordShiftEnd(phone.context, { shiftId, location: null });
    const onPhone = (await phone.db.read((sql) => localJob(sql, id)))!.detail;

    // Signal again, a while later.
    await pause(1000);
    phone.network.online = true;
    expect((await phone.sync()).outcome).toBe('complete');

    const server = await call<
      Detail & {
        attachments: { stage: string | null; kind: string }[];
        events: { kind: string; toState: string | null; occurredAt: string; recordedAt: string }[];
        execution: { signoff: { name: string; role: string } | null };
        forms: { submission: { status: string } | null }[];
      }
    >(officeToken, 'GET', `/v1/work-orders/${id}`);
    expect(server.workOrder.state).toBe('complete');
    expect(server.forms[0]?.submission?.status).toBe('submitted');
    expect(
      server.attachments.map((attachment) => attachment.stage ?? attachment.kind).sort(),
    ).toEqual(['after', 'after', 'before', 'site_plan']);
    expect(server.execution.signoff).toMatchObject({ name: 'Mrs Patel', role: 'Tenant' });

    // Times as the phone recorded them, not as they synced.
    const moment = (events: { toState: string | null; occurredAt: string }[], to: string) =>
      Date.parse(events.find((event) => event.toState === to)!.occurredAt);
    const serverEvents = server.events;
    const phoneEvents = onPhone.events;
    for (const [from, to] of [
      ['travelling', 'on_site'],
      ['on_site', 'in_progress'],
      ['in_progress', 'complete'],
    ] as const) {
      const onServer = moment(serverEvents, to) - moment(serverEvents, from);
      const recorded = moment(phoneEvents, to) - moment(phoneEvents, from);
      expect(Math.abs(onServer - recorded), `${from} → ${to}`).toBeLessThan(100);
    }
    const completedEvent = serverEvents.find((event) => event.toState === 'complete')!;
    expect(
      Date.parse(completedEvent.recordedAt) - Date.parse(completedEvent.occurredAt),
    ).toBeGreaterThan(900);

    const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const timesheet = await call<{
      shifts: { id: string; startedAt: string; endedAt: string | null }[];
    }>(
      officeToken,
      'GET',
      `/v1/timesheets?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&userId=${engineer.userId}`,
    );
    const shift = timesheet.shifts.find((candidate) => candidate.id === shiftId)!;
    expect(shift.endedAt).not.toBeNull();
    expect(Date.parse(shift.startedAt)).toBeLessThan(moment(serverEvents, 'travelling'));
  });
});

describe('clocks and flaky networks', () => {
  it('accepts a form filled two days ago offline, judging its day by when the phone recorded it', async () => {
    const job = await newJob([engineer]);
    const clock = new SkewedClock(-2 * 24 * 60 * 60 * 1000);
    const phone = await openPhone(api, engineer, { clock });
    clock.offsetMs = 0;
    await phone.sync();
    phone.network.online = false;
    const { submissionId } = await recordFormStarted(phone.context, {
      formId,
      formVersionId: await liveVersion(phone),
      workOrderId: job.workOrder.id,
    });

    // Two days ago, by a clock that was right then.
    clock.offsetMs = -2 * 24 * 60 * 60 * 1000;
    const signature = await photo(phone, job.workOrder.id, 'image/png', 10_000);
    await recordSubmit(phone.context, {
      submissionId,
      answers: {
        note: 'Filled on Monday',
        engineer_signature: signature,
        customer_signature: signature,
      },
      filledOn: today(clock),
    });
    clock.offsetMs = 0;
    phone.network.online = true;
    expect(await phone.sync()).toMatchObject({ outcome: 'complete', rejected: 0 });
  });

  it('works with a phone clock hours out, and reports the offset it measured', async () => {
    const job = await newJob([engineer]);
    const clock = new SkewedClock(3 * 60 * 60 * 1000);
    const phone = await openPhone(api, engineer, { clock });
    await phone.sync();
    await recordComment(phone.context, {
      workOrderId: job.workOrder.id,
      body: 'Clock is fast',
      visibility: 'internal',
    });
    expect((await phone.sync()).outcome).toBe('complete');
    const offset = await phone.db.read((sql) =>
      sql.get<{ value: string }>(`select value from meta where key = 'clock_offset_ms'`),
    );
    expect(Math.abs(Number(offset?.value) + 3 * 60 * 60 * 1000)).toBeLessThan(60_000);
    const reports = await withTenant(api.tenantId, (tx) =>
      tx.sync.listReports({ userId: engineer.userId }),
    );
    expect(Math.abs(reports[0]!.started_at.getTime() - Date.now())).toBeLessThan(5 * 60 * 1000);
  });

  it('backs off after server errors and sends the change when its time comes', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    await recordComment(phone.context, {
      workOrderId: job.workOrder.id,
      body: 'After the outage',
      visibility: 'internal',
    });
    phone.network.fail((method, path) => method === 'POST' && path === '/v1/sync/push', 503, 1);
    expect((await phone.sync()).outcome).toBe('partial');
    expect(
      await phone.db.read((sql) =>
        sql.get('select attempts from outbox where state = ?', ['pending']),
      ),
    ).toEqual({
      attempts: 1,
    });
    // Too soon: nothing goes.
    await phone.sync();
    expect(
      (await serverJob(job.workOrder.id)).comments.map((comment) => comment.body),
    ).not.toContain('After the outage');
    phone.clock.offsetMs += 60_000;
    await phone.sync();
    expect((await serverJob(job.workOrder.id)).comments.map((comment) => comment.body)).toContain(
      'After the outage',
    );
  });

  it('holds uploads on a low battery, and sends them when the engineer forces it', async () => {
    const job = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    await photo(phone, job.workOrder.id);
    phone.battery.level = 0.08;
    expect(await phone.sync()).toMatchObject({ uploadsPaused: 'low_battery', uploadsCompleted: 0 });
    expect(await phone.sync('manual', true)).toMatchObject({
      uploadsPaused: null,
      uploadsCompleted: 1,
    });
  });
});

describe('a job taken off the engineer', () => {
  it('leaves the phone when there is nothing unsent, and stays, flagged, when there is', async () => {
    const quiet = await newJob([engineer]);
    const busy = await newJob([engineer]);
    const phone = await openPhone(api, engineer);
    await phone.sync();
    phone.network.online = false;
    await recordComment(phone.context, {
      workOrderId: busy.workOrder.id,
      body: 'Too late',
      visibility: 'internal',
    });
    for (const job of [quiet, busy]) {
      await call(officeToken, 'PUT', `/v1/work-orders/${job.workOrder.id}/crew`, {
        crew: [{ userId: crewmate.userId, lead: true }],
      });
    }
    phone.network.online = true;
    await phone.sync();
    expect(await phone.db.read((sql) => localJob(sql, quiet.workOrder.id))).toBeUndefined();
    expect(await phone.db.read((sql) => localJob(sql, busy.workOrder.id))).toBeDefined();
    const [refused] = await phone.db.read(changesNeedingAttention);
    expect(refused).toMatchObject({
      state: 'failed',
      lastError: { code: 'work_order_unavailable' },
    });
    expect((await phone.db.read((sql) => jobSyncState(sql, busy.workOrder.id))).safeToLeave).toBe(
      false,
    );
    void getPlatformDataSource;
  });
});
