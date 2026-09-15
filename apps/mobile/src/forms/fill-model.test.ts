import { type CompiledForm, compileDefinition } from '@integr8/form-engine';
import { geoPointFrom, readInteger, toggleOption, withOffset } from '@integr8/form-input';
import {
  applySnapshot,
  type ChangeContext,
  fillSession,
  queueUpload,
  recordAnswers,
  recordFormStarted,
  recordSubmit,
  selectBatch,
} from '@integr8/offline';
import { customerDetail, formDetail, me, workOrderDetail } from '@integr8/offline/testing';
import { openTestDatabase } from '@integr8/offline/testing';
import { describe, expect, it } from 'vitest';
import { FillModel } from './fill-model';

/**
 * The phone's form filling, driven the way the screen drives it, against the
 * phone's real local database (Node's SQLite). What only a phone can show —
 * camera, GPS, the keyboard, a real app kill — is on the device checklist.
 */

const label = (en: string) => ({ en });
const options = (...values: string[]) => values.map((value) => ({ value, label: label(value) }));

/** Twenty questions over three pages, every kind an engineer meets, one shown only on a fail. */
const TWENTY = {
  schemaVersion: 1,
  title: label('Boiler service'),
  pages: [
    {
      id: 'appliance',
      title: label('Appliance'),
      sections: [
        {
          id: 'identity',
          fields: [
            { id: 'make', type: 'text', label: label('Make'), required: true },
            { id: 'model', type: 'text', label: label('Model') },
            { id: 'serial', type: 'barcode', label: label('Serial'), required: true },
            { id: 'fuel', type: 'dropdown', label: label('Fuel'), options: options('gas', 'oil') },
            { id: 'installed', type: 'date', label: label('Installed') },
            {
              id: 'location',
              type: 'radio',
              label: label('Where'),
              options: options('kitchen', 'loft'),
            },
          ],
        },
      ],
    },
    {
      id: 'checks',
      title: label('Checks'),
      sections: [
        {
          id: 'readings',
          fields: [
            {
              id: 'pressure',
              type: 'decimal',
              label: label('Pressure'),
              decimalPlaces: 2,
              unit: 'bar',
            },
            { id: 'visits', type: 'number', label: label('Visits this year') },
            { id: 'arrived', type: 'time', label: label('Arrived') },
            { id: 'finished', type: 'datetime', label: label('Finished') },
            {
              id: 'done',
              type: 'multi_select',
              label: label('Checked'),
              options: options('flue', 'seals', 'fan'),
            },
            { id: 'isolated', type: 'checkbox', label: label('Gas isolated'), required: true },
            {
              id: 'safe',
              type: 'yes_no',
              label: label('Safe to use'),
              required: true,
              allowNotApplicable: true,
            },
            {
              id: 'why_unsafe',
              type: 'long_text',
              label: label('Why not'),
              required: true,
              visibleWhen: {
                kind: 'compare',
                operator: 'eq',
                left: { kind: 'answer', field: 'safe' },
                right: { kind: 'text', value: 'no' },
              },
            },
            { id: 'condition', type: 'rating', label: label('Condition'), scale: 5 },
            { id: 'notes', type: 'long_text', label: label('Notes') },
          ],
        },
      ],
    },
    {
      id: 'sign_off',
      title: label('Sign-off'),
      sections: [
        {
          id: 'evidence',
          fields: [
            { id: 'photos', type: 'photo', label: label('Photos'), maxFiles: 10 },
            { id: 'certificate', type: 'file', label: label('Certificate') },
            { id: 'where', type: 'gps', label: label('Where') },
            { id: 'engineer', type: 'signature', label: label('Engineer'), required: true },
          ],
        },
      ],
    },
  ],
};

function compiled(definition: unknown): CompiledForm {
  const result = compileDefinition(definition);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.form;
}

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const form = formDetail();
  const live = { ...form, live: { ...form.live!, definition: TWENTY as never } };
  const job = workOrderDetail(customer, { formIds: [form.form.id] });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [job], customers: [customer], forms: [live] },
      new Date('2026-09-15T08:00:00.000Z'),
    ),
  );
  const context: ChangeContext = {
    db,
    clock: { now: () => new Date('2026-09-15T10:00:00.000Z') },
    random: (length) => Uint8Array.from({ length }, () => Math.floor(Math.random() * 256)),
  };
  const { submissionId } = await recordFormStarted(context, {
    formId: form.form.id,
    formVersionId: live.live.id,
    workOrderId: job.workOrder.id,
  });
  return { db, context, submissionId, jobId: job.workOrder.id };
}

function open(context: ChangeContext, submissionId: string, answers: Record<string, unknown>) {
  let saves = 0;
  const model = new FillModel({
    form: compiled(TWENTY),
    answers,
    context: { today: '2026-09-15' },
    save: async (latest) => {
      saves += 1;
      await recordAnswers(context, { submissionId, answers: latest });
    },
  });
  return { model, saves: () => saves };
}

const photo = (mediaId: string) => ({ mediaId, contentType: 'image/jpeg', byteSize: 640_000 });

describe('a twenty-question form on the phone, offline', () => {
  it('saves every change, survives the app being killed half-way, and submits through the outbox', async () => {
    const { db, context, submissionId, jobId } = await phone();

    // First visit: page one, and part of page two, then the app is killed.
    const first = open(context, submissionId, {});
    first.model.answer('make', 'Worcester');
    first.model.answer('model', 'Greenstar 30i');
    first.model.answer('serial', 'GC-47-406-12');
    first.model.answer('fuel', 'gas');
    first.model.answer('installed', '2019-03-02');
    first.model.answer('location', 'kitchen');
    first.model.next();
    first.model.answer('pressure', '1.50');
    const typed = readInteger('٢');
    first.model.answer('visits', typed.answer);
    await first.model.flush();
    // Typing faster than the database writes is one write per settled burst, not one per key.
    expect(first.saves()).toBeLessThan(8);

    // Reopened from the phone alone — the same answers, nothing lost.
    const session = await db.read((sql) => fillSession(sql, submissionId));
    expect(session?.submission.answers).toEqual({
      make: 'Worcester',
      model: 'Greenstar 30i',
      serial: 'GC-47-406-12',
      fuel: 'gas',
      installed: '2019-03-02',
      location: 'kitchen',
      pressure: '1.50',
      visits: 2,
    });

    const second = open(context, submissionId, session!.submission.answers);
    const { model } = second;
    model.answer('arrived', '08:30');
    model.answer('finished', withOffset('2026-09-15T10:45', 60));
    model.answer('done', toggleOption(options('flue', 'seals', 'fan'), ['fan'], 'flue', true));
    model.answer('isolated', true);
    model.answer('safe', 'no');
    model.answer('why_unsafe', 'Flue spillage');
    model.answer('condition', 3);
    model.answer('notes', 'Advised replacement');
    model.answer('safe', 'yes');

    // Ten photos taken offline, queued before they are answered.
    const photos: ReturnType<typeof photo>[] = [];
    for (let index = 0; index < 10; index += 1) {
      const mediaId = await queueUpload(context, {
        localPath: `captures/p${String(index)}.jpg`,
        thumbnailPath: `captures/p${String(index)}.thumb.jpg`,
        contentType: 'image/jpeg',
        byteSize: 640_000,
        workOrderId: jobId,
      });
      photos.push(photo(mediaId));
      model.answer('photos', [...photos]);
    }
    model.answer('where', geoPointFrom({ latitude: 53.8007, longitude: -1.5491, accuracy: 6 }));

    // Reviewing with the signature missing opens its page and lists only it.
    const refused = model.review();
    expect(refused).toEqual({ ok: false, firstField: 'engineer' });
    expect(model.snapshot().problems.map((problem) => problem.field)).toEqual(['engineer']);
    expect(model.snapshot().pages[model.snapshot().pageIndex]?.id).toBe('sign_off');

    const signature = await queueUpload(context, {
      localPath: 'captures/sig.png',
      contentType: 'image/png',
      byteSize: 9_000,
      workOrderId: jobId,
    });
    model.answer('engineer', { mediaId: signature, contentType: 'image/png', byteSize: 9_000 });
    expect(model.review()).toEqual({ ok: true });
    expect(model.snapshot().reviewing).toBe(true);
    expect(model.snapshot().progress).toBe(1);

    // What is submitted is the engine's: the hidden "why not" is gone though it was typed.
    await model.flush();
    const answers = model.submission();
    expect(answers).not.toHaveProperty('why_unsafe');
    // Twenty questions, less the hidden one and the certificate nobody attached.
    expect(Object.keys(answers)).toHaveLength(18);
    expect(answers.done).toEqual(['flue', 'fan']);
    expect(answers.finished).toBe('2026-09-15T10:45:00+01:00');

    await recordSubmit(context, {
      submissionId,
      answers,
      filledOn: '2026-09-15',
      location: { status: 'unavailable' },
    });
    const outbox = await db.read((sql) =>
      sql.all<{ kind: string; payload: string; waits_for: string }>(
        `select kind, payload, waits_for from outbox where state = 'pending' order by seq`,
      ),
    );
    expect(outbox.map((row) => row.kind)).toEqual(['submission.start', 'submission.submit']);
    const submit = JSON.parse(outbox[1]!.payload) as Record<string, unknown>;
    expect(submit).toMatchObject({ answers, location: { status: 'unavailable' } });
    expect((JSON.parse(outbox[1]!.waits_for) as { media: string[] }).media).toHaveLength(11);
    // Nothing goes until the eleven files have: the submit waits in the outbox.
    const batch = await db.read((sql) => selectBatch(sql, new Date('2026-09-15T10:00:00.000Z')));
    expect(batch.mutations.map((mutation) => mutation.kind)).toEqual(['submission.start']);
  });

  it('keeps answers it could not save, and saves them when asked again', async () => {
    let fail = true;
    const saved: Record<string, unknown>[] = [];
    const model = new FillModel({
      form: compiled(TWENTY),
      answers: {},
      context: { today: '2026-09-15' },
      save: (answers) => {
        if (fail) {
          return Promise.reject(new Error('disk full'));
        }
        saved.push(answers);
        return Promise.resolve();
      },
    });
    model.answer('make', 'Ideal');
    await expect(model.flush()).rejects.toThrow(/could not be saved/u);
    expect(model.snapshot().saveStatus).toBe('failed');
    fail = false;
    await model.flush();
    expect(model.snapshot().saveStatus).toBe('saved');
    expect(saved.at(-1)).toEqual({ make: 'Ideal' });
  });

  it('refuses what the engine refuses, and never saves it', async () => {
    const saved: unknown[] = [];
    const model = new FillModel({
      form: compiled(TWENTY),
      answers: {},
      context: {},
      save: (answers) => {
        saved.push(answers);
        return Promise.resolve();
      },
    });
    expect(model.answer('visits', 'two')).toMatchObject({ accepted: false });
    expect(model.answer('nope', 'x')).toMatchObject({ accepted: false });
    await model.flush();
    expect(saved).toEqual([]);
  });
});
