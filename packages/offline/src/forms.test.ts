import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evict } from './eviction.js';
import { earlierAnswersAtSite, fillSession, jobForms, localMedia } from './forms.js';
import { applySnapshot } from './snapshot.js';

import {
  applyPushResults,
  markSent,
  queueUpload,
  recordAnswers,
  recordFormStarted,
  recordSubmit,
  selectBatch,
} from './sync/outbox.js';
import { discardUnusedUpload } from './sync/uploads.js';
import { customerDetail, formDetail, me, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const NOW = new Date('2026-09-15T10:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));

async function phone() {
  const { db, driver } = await openTestDatabase();
  const customer = customerDetail();
  const form = formDetail();
  const [today, lastYear] = [
    workOrderDetail(customer, { formIds: [form.form.id] }),
    workOrderDetail(customer, {
      formIds: [form.form.id],
      state: 'complete',
      completedAt: '2026-09-01T09:00:00.000Z',
    }),
  ];
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [today, lastYear], customers: [customer], forms: [form] },
      NOW,
    ),
  );
  const clock = { current: NOW, now: () => clock.current };
  const context = { db, clock, random };
  return { db, driver, context, form, today, lastYear, clock };
}

describe('the forms a job needs', () => {
  it('shows each as the phone has it: not started, started offline, sent', async () => {
    const { db, context, form, today } = await phone();
    const liveVersionId = form.live!.id;
    expect(await db.read((sql) => jobForms(sql, today.workOrder.id))).toEqual([
      {
        formId: form.form.id,
        title: 'Gas safety check',
        required: true,
        liveVersionId,
        submission: null,
      },
    ]);

    const { submissionId } = await recordFormStarted(context, {
      formId: form.form.id,
      formVersionId: liveVersionId,
      workOrderId: today.workOrder.id,
    });
    await recordAnswers(context, { submissionId, answers: { make: 'Worcester' } });
    const [started] = await db.read((sql) => jobForms(sql, today.workOrder.id));
    expect(started?.submission).toMatchObject({ id: submissionId, status: 'draft', sent: false });

    const session = await db.read((sql) => fillSession(sql, submissionId));
    expect(session).toMatchObject({
      submission: { status: 'draft', answers: { make: 'Worcester' }, formVersionId: liveVersionId },
      formTitle: 'Gas safety check',
      definition: { schemaVersion: 1 },
      job: { id: today.workOrder.id, siteId: today.site.id },
    });
    expect(await db.read((sql) => fillSession(sql, 'nope'))).toBeUndefined();
  });
});

describe('starting from earlier answers', () => {
  it('finds the latest submitted form at the same site, never the one being filled', async () => {
    const { db, context, form, today, lastYear, clock } = await phone();
    const versionId = form.live!.id;
    const earlier = await recordFormStarted(context, {
      formId: form.form.id,
      formVersionId: versionId,
      workOrderId: lastYear.workOrder.id,
    });
    await recordSubmit(context, {
      submissionId: earlier.submissionId,
      answers: { make: 'Vaillant' },
      filledOn: '2026-09-01',
    });
    clock.current = new Date(NOW.getTime() + 60_000);
    const current = await recordFormStarted(context, {
      formId: form.form.id,
      formVersionId: versionId,
      workOrderId: today.workOrder.id,
    });

    const found = await db.read((sql) =>
      earlierAnswersAtSite(sql, {
        formId: form.form.id,
        siteId: today.site.id,
        excludeSubmissionId: current.submissionId,
      }),
    );
    expect(found).toMatchObject({
      submissionId: earlier.submissionId,
      answers: { make: 'Vaillant' },
      job: { id: lastYear.workOrder.id },
    });
    expect(
      await db.read((sql) =>
        earlierAnswersAtSite(sql, {
          formId: form.form.id,
          siteId: 'another-site',
          excludeSubmissionId: current.submissionId,
        }),
      ),
    ).toBeUndefined();
  });
});

describe('photos taken on the phone', () => {
  it('are found by id with their thumbnails, and leave with their job once uploaded', async () => {
    const { db, context, lastYear } = await phone();
    const mediaId = await queueUpload(context, {
      localPath: 'captures/a.jpg',
      thumbnailPath: 'captures/a.thumb.jpg',
      contentType: 'image/jpeg',
      byteSize: 1000,
      workOrderId: lastYear.workOrder.id,
    });
    expect((await db.read((sql) => localMedia(sql, [mediaId, 'other']))).get(mediaId)).toEqual({
      mediaId,
      localPath: 'captures/a.jpg',
      thumbnailPath: 'captures/a.thumb.jpg',
      contentType: 'image/jpeg',
      byteSize: 1000,
      state: 'queued',
    });

    // Waiting to upload: kept however old the job.
    const later = new Date('2026-12-01T00:00:00.000Z');
    expect((await db.write(['uploads'], (sql) => evict(sql, later))).filePaths).toEqual([]);

    await db.write(['uploads'], (sql) =>
      sql.run(`update uploads set state = 'confirmed' where media_id = ?`, [mediaId]),
    );
    const outcome = await db.write(['uploads'], (sql) => evict(sql, later));
    expect(outcome.workOrders).toBe(1);
    expect(outcome.filePaths).toEqual(['captures/a.jpg', 'captures/a.thumb.jpg']);
    expect((await db.read((sql) => localMedia(sql, [mediaId]))).size).toBe(0);
  });
});

describe('taking a photo back out of a form', () => {
  it('drops its upload only when nothing on the phone still names it', async () => {
    const { db, context, form, today } = await phone();
    const { submissionId } = await recordFormStarted(context, {
      formId: form.form.id,
      formVersionId: form.live!.id,
      workOrderId: today.workOrder.id,
    });
    const queue = (name: string) =>
      queueUpload(context, {
        localPath: `captures/${name}.jpg`,
        thumbnailPath: `captures/${name}.thumb.jpg`,
        contentType: 'image/jpeg',
        byteSize: 10,
        workOrderId: today.workOrder.id,
      });
    const kept = await queue('kept');
    const removed = await queue('removed');
    await recordAnswers(context, {
      submissionId,
      answers: { photos: [{ mediaId: kept, contentType: 'image/jpeg', byteSize: 10 }] },
    });

    expect(await discardUnusedUpload(db, kept)).toEqual([]);
    expect(await discardUnusedUpload(db, removed)).toEqual([
      'captures/removed.jpg',
      'captures/removed.thumb.jpg',
    ]);
    expect([...(await db.read((sql) => localMedia(sql, [kept, removed]))).keys()]).toEqual([kept]);
  });
});

describe('autosaving while a save is on its way', () => {
  it('never folds new answers into a change the server may already have', async () => {
    const { db, context, form, today, clock } = await phone();
    const { mutationId: started, submissionId } = await recordFormStarted(context, {
      formId: form.form.id,
      formVersionId: form.live!.id,
      workOrderId: today.workOrder.id,
    });
    await db.write(['outbox', 'submissions'], async (sql) => {
      const { rows } = await selectBatch(sql, clock.now());
      await applyPushResults(
        sql,
        rows,
        [
          {
            id: started,
            outcome: 'applied',
            replayed: false,
            alreadyApplied: false,
            revision: 1,
            answers: {},
          },
        ],
        clock.now(),
      );
    });

    const first = await recordAnswers(context, { submissionId, answers: { make: 'W' } });
    // The engine takes it and sends it...
    const inFlight = await db.write(['outbox'], async (sql) => {
      const batch = await selectBatch(sql, clock.now());
      await markSent(sql, batch.rows, clock.now());
      return batch;
    });
    expect(inFlight.mutations.map((mutation) => mutation.id)).toEqual([first]);

    // ...while the engineer keeps typing, and then submits.
    const second = await recordAnswers(context, { submissionId, answers: { make: 'Wo' } });
    expect(second).not.toBe(first);
    expect(await recordAnswers(context, { submissionId, answers: { make: 'Worc' } })).toBe(second);
    await recordSubmit(context, {
      submissionId,
      answers: { make: 'Worcester' },
      filledOn: '2026-09-15',
    });

    const outbox = await db.read((sql) =>
      sql.all<{ id: string; kind: string; payload: string }>(
        `select id, kind, payload from outbox where state = 'pending' order by seq`,
      ),
    );
    expect(
      outbox.map((row) => [
        row.id === first ? 'first' : row.kind,
        JSON.parse(row.payload) as unknown,
      ]),
    ).toEqual([
      ['first', { answers: { make: 'W' } }],
      ['submission.submit', { answers: { make: 'Worcester' }, filledOn: '2026-09-15' }],
    ]);
  });
});
