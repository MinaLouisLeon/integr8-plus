import { findTransition } from '@integr8/core';
import type {
  AccessValues,
  MaterialBody,
  MutationKind,
  PushMutation,
  PushResult,
  SubmitLocation,
  SyncConflict,
  WorkOrderDetail,
} from '../api-types.js';
import type { LocalDatabase } from '../database.js';
import {
  applyConditionLocally,
  type AssetSync,
  type ConditionValue,
  writeAsset,
} from '../assets.js';
import type { SqlConnection } from '../sql.js';
import type { DeviceClock } from './clock.js';
import { type RandomBytes, uuidv7 } from './ids.js';
import { type Actor, applyToJob, closedAtOf, type LocalChange } from './overlay.js';

/**
 * The outbox: every change made on the phone, durable and in order (P12).
 *
 * A change is written to the phone's own copy of the record and to the outbox
 * **in one transaction**, so the screen shows it at once and it cannot be lost
 * between the two. It then waits for the sync engine, which sends changes in the
 * order they were made and marks each with what the server did:
 *
 * - `pending`  — not yet applied; retried with backoff.
 * - `conflict` — the server holds a different version; the engineer decides.
 * - `failed`   — refused, and sending it again would not help; shown to the engineer.
 * - `done`     — applied.
 *
 * Only `done` lets later changes to the same record through. A job's "completed"
 * never overtakes its "arrived".
 */

export interface ChangeContext {
  db: LocalDatabase;
  clock: DeviceClock;
  random: RandomBytes;
}

/**
 * Every reason the phone refuses a change before queuing it. A screen says
 * each one in the engineer's language by this code (ADR-0012), never by the
 * English message, so the list is the contract: a code thrown that is not on
 * it does not compile, and a test in the mobile app fails when one has no
 * words.
 */
export const LOCAL_CHANGE_ERROR_CODES = [
  'amount_invalid',
  'asset_not_at_site',
  'asset_not_on_phone',
  'asset_retired',
  'category_unknown',
  'change_done',
  'change_unknown',
  'checklist_item_unknown',
  'claim_not_on_phone',
  'date_invalid',
  'description_required',
  'form_not_on_phone',
  'form_submitted',
  'item_not_in_van',
  'lot_not_in_van',
  'lots_mismatch',
  'name_required',
  'note_required',
  'not_an_access_conflict',
  'not_an_answers_conflict',
  'part_description_required',
  'purchase_not_on_phone',
  'quantity_invalid',
  'serial_required',
  'shift_not_open',
  'shift_open',
  'site_not_on_phone',
  'spent_in_future',
  'transition_not_allowed',
  'unit_price_invalid',
  'visit_final',
  'visit_unknown',
  'work_order_not_on_phone',
] as const;
export type LocalChangeErrorCode = (typeof LOCAL_CHANGE_ERROR_CODES)[number];

export class LocalChangeError extends Error {
  constructor(
    readonly code: LocalChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalChangeError';
  }
}

export type OutboxState = 'pending' | 'conflict' | 'failed' | 'done';

export interface Waits {
  media: string[];
  mutations: string[];
}

export interface OutboxRow {
  seq: number;
  id: string;
  kind: MutationKind;
  entityKey: string;
  entityId: string;
  workOrderId: string | null;
  payload: Record<string, unknown>;
  base: Record<string, unknown> | null;
  waitsFor: Waits;
  recordedAt: string;
  state: OutboxState;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: { code: string; message: string; details?: unknown } | null;
  conflict: SyncConflict | null;
}

interface RawRow {
  seq: number;
  id: string;
  kind: string;
  entity_key: string;
  entity_id: string;
  work_order_id: string | null;
  payload: string;
  base: string | null;
  waits_for: string;
  recorded_at: string;
  state: OutboxState;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  conflict: string | null;
}

function toRow(raw: RawRow): OutboxRow {
  const waits = JSON.parse(raw.waits_for) as Partial<Waits> | unknown[];
  return {
    seq: raw.seq,
    id: raw.id,
    kind: raw.kind as MutationKind,
    entityKey: raw.entity_key,
    entityId: raw.entity_id,
    workOrderId: raw.work_order_id,
    payload: JSON.parse(raw.payload) as Record<string, unknown>,
    base: raw.base === null ? null : (JSON.parse(raw.base) as Record<string, unknown>),
    waitsFor: Array.isArray(waits)
      ? { media: [], mutations: [] }
      : { media: waits.media ?? [], mutations: waits.mutations ?? [] },
    recordedAt: raw.recorded_at,
    state: raw.state,
    attempts: raw.attempts,
    nextAttemptAt: raw.next_attempt_at,
    lastError:
      raw.last_error === null ? null : (JSON.parse(raw.last_error) as OutboxRow['lastError']),
    conflict: raw.conflict === null ? null : (JSON.parse(raw.conflict) as SyncConflict),
  };
}

/** Kinds whose base is filled in when sent, from what the server last confirmed. */
const LAZY_BASE: ReadonlySet<MutationKind> = new Set(['submission.answers', 'submission.submit']);

const OUTBOX_TABLES = [
  'meta',
  'shifts',
  'outbox',
  'work_orders',
  'sites',
  'submissions',
  'uploads',
  'files',
  'van_stock',
  'assets',
  'asset_links',
] as const;

async function actorOf(sql: SqlConnection): Promise<Actor> {
  const rows = await sql.all<{ key: string; value: string }>(
    `select key, value from meta where key in ('user_id', 'display_name')`,
  );
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return { id: meta.get('user_id') ?? '', name: meta.get('display_name') ?? '' };
}

async function insertChange(
  sql: SqlConnection,
  change: {
    id: string;
    kind: MutationKind;
    entityKey: string;
    entityId: string;
    workOrderId: string | null;
    payload: unknown;
    base: unknown;
    waitsFor?: Waits;
    at: string;
  },
): Promise<void> {
  await sql.run(
    `insert into outbox (id, kind, entity_key, entity_id, work_order_id, payload, base, waits_for,
                         recorded_at, state, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      change.id,
      change.kind,
      change.entityKey,
      change.entityId,
      change.workOrderId,
      JSON.stringify(change.payload),
      change.base === null || change.base === undefined ? null : JSON.stringify(change.base),
      JSON.stringify(change.waitsFor ?? { media: [], mutations: [] }),
      change.at,
      change.at,
    ],
  );
}

async function jobDetail(sql: SqlConnection, workOrderId: string): Promise<WorkOrderDetail> {
  const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
    workOrderId,
  ]);
  if (row === undefined) {
    throw new LocalChangeError('work_order_not_on_phone', 'This job is not on this phone.');
  }
  return JSON.parse(row.data) as WorkOrderDetail;
}

async function writeJob(sql: SqlConnection, detail: WorkOrderDetail): Promise<void> {
  await sql.run('update work_orders set state = ?, closed_at = ?, data = ? where id = ?', [
    detail.workOrder.state,
    closedAtOf(detail),
    JSON.stringify(detail),
    detail.workOrder.id,
  ]);
}

async function applyLocally(
  sql: SqlConnection,
  workOrderId: string,
  change: LocalChange,
  at: string,
): Promise<WorkOrderDetail> {
  const next = applyToJob(await jobDetail(sql, workOrderId), change, await actorOf(sql), at);
  await writeJob(sql, next);
  return next;
}

/** Asks the next sync to fetch this job afresh. */
export async function requestRefresh(
  sql: SqlConnection,
  workOrderId: string | null,
): Promise<void> {
  if (workOrderId === null) {
    return;
  }
  const row = await sql.get<{ value: string }>(
    `select value from meta where key = 'refresh_work_orders'`,
  );
  const ids = new Set(row === undefined ? [] : (JSON.parse(row.value) as string[]));
  ids.add(workOrderId);
  await sql.run(
    `insert into meta (key, value) values ('refresh_work_orders', ?)
     on conflict (key) do update set value = excluded.value`,
    [JSON.stringify([...ids])],
  );
}

// ---------------------------------------------------------------------------
// Recording changes
// ---------------------------------------------------------------------------

export async function recordTransition(
  context: ChangeContext,
  input: { workOrderId: string; to: WorkOrderDetail['workOrder']['state']; reason?: string },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const detail = await jobDetail(sql, input.workOrderId);
    const from = detail.workOrder.state;
    if (findTransition(from, input.to) === undefined) {
      throw new LocalChangeError(
        'transition_not_allowed',
        `A ${from} job cannot move to ${input.to}.`,
      );
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const payload = {
      to: input.to,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    };
    // Completing waits for the job's forms, photos and sign-off to reach the
    // server first, or the server would refuse it for want of what is only on its way.
    const waitsFor: Waits = { media: [], mutations: [] };
    if (input.to === 'complete') {
      const pendingForms = await sql.all<{ id: string }>(
        `select id from outbox where work_order_id = ? and state <> 'done'
           and (kind like 'submission.%' or kind in ('work_order.photo', 'work_order.photo_remove', 'work_order.signoff'))`,
        [input.workOrderId],
      );
      waitsFor.mutations = pendingForms.map((row) => row.id);
    }
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.transition', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.transition',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: { state: from, revision: detail.workOrder.revision },
      waitsFor,
      at,
    });
    return id;
  });
}

export async function recordChecklist(
  context: ChangeContext,
  input: { workOrderId: string; itemId: string; done: boolean },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const detail = await jobDetail(sql, input.workOrderId);
    if (!detail.checklist.some((item) => item.id === input.itemId)) {
      throw new LocalChangeError(
        'checklist_item_unknown',
        'This checklist item is not on the job.',
      );
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const payload = { itemId: input.itemId, done: input.done };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.checklist', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.checklist',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return id;
  });
}

/**
 * Marks one of the job's visits done (P25), at the phone's time. A visit that
 * is already done is left alone; a cancelled one cannot be done.
 */
export async function recordVisitDone(
  context: ChangeContext,
  input: { workOrderId: string; visitId: string },
): Promise<string | undefined> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const detail = await jobDetail(sql, input.workOrderId);
    const visit = detail.visits.find((candidate) => candidate.id === input.visitId);
    if (visit === undefined) {
      throw new LocalChangeError('visit_unknown', 'This visit is not on the job.');
    }
    if (visit.status === 'done') {
      return undefined;
    }
    if (visit.status === 'cancelled') {
      throw new LocalChangeError('visit_final', 'This visit was cancelled.');
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const payload = { visitId: input.visitId };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.visit_done', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.visit_done',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return id;
  });
}

/** A decimal of up to four places as ten-thousandths, compared exactly. */
const tenThousandths = (text: string) => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole + fraction.padEnd(4, '0').slice(0, 4));
};

/**
 * The serial numbers or batches a part use names, checked against the van's
 * list: each one there, named once, a serial number one unit, adding up to the
 * quantity. A serial-numbered part names its own; a batch may be left to the
 * server, which takes the one expiring first.
 */
function checkLots(
  tracking: string,
  vanLots: readonly { lotId: string }[],
  quantity: string,
  lots: readonly { lotId: string; quantity: string }[],
): { lotId: string; quantity: string }[] {
  if (tracking === 'none') {
    if (lots.length > 0) {
      throw new LocalChangeError('lots_mismatch', 'This part has no serial numbers or batches.');
    }
    return [];
  }
  if (tracking === 'serial' && lots.length === 0) {
    throw new LocalChangeError('serial_required', 'Choose the serial number of each part fitted.');
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const lot of lots) {
    if (!vanLots.some((candidate) => candidate.lotId === lot.lotId)) {
      throw new LocalChangeError(
        'lot_not_in_van',
        'This serial number or batch is not in your van.',
      );
    }
    if (
      seen.has(lot.lotId) ||
      !/^\d{1,16}(\.\d{1,4})?$/u.test(lot.quantity) ||
      (tracking === 'serial' && tenThousandths(lot.quantity) !== 10_000n)
    ) {
      throw new LocalChangeError('lots_mismatch', 'Check the serial numbers or batches chosen.');
    }
    seen.add(lot.lotId);
    sum += tenThousandths(lot.quantity);
  }
  if (lots.length > 0 && sum !== tenThousandths(quantity)) {
    throw new LocalChangeError(
      'lots_mismatch',
      'The serial numbers or batches chosen do not add up to the quantity.',
    );
  }
  return lots.map(({ lotId, quantity: each }) => ({ lotId, quantity: each }));
}

/**
 * A part used on the job, from the engineer's van (CRM/ERP plan, phase E2;
 * ADR-0005). The item must be one the van holds, as the server last said; the
 * server decides whether enough is left when the change arrives, so the phone
 * records what was asked for and shows it at once.
 */
export async function recordMaterial(
  context: ChangeContext,
  input: {
    workOrderId: string;
    itemId: string;
    quantity: string;
    note?: string;
    /**
     * For a serial-numbered or batched item: which, from the van's list
     * (ADR-0013). Serial numbers are named one each; a batch named or not —
     * the server then takes the one expiring first.
     */
    lots?: { lotId: string; quantity: string }[];
    /** An expired batch confirmed; the note says why. */
    allowExpired?: boolean;
  },
): Promise<string> {
  const { db, clock, random } = context;
  if (!/^\d{1,16}(\.\d{1,4})?$/u.test(input.quantity) || !/[1-9]/u.test(input.quantity)) {
    throw new LocalChangeError('quantity_invalid', 'Enter a quantity above zero.');
  }
  return db.write(OUTBOX_TABLES, async (sql) => {
    await jobDetail(sql, input.workOrderId);
    const held = await sql.get<{
      location_id: string;
      location_name: string;
      sku: string;
      name: string;
      kind: string;
      unit: string;
      tracking: string;
      lots: string | null;
    }>(
      'select location_id, location_name, sku, name, kind, unit, tracking, lots from van_stock where item_id = ?',
      [input.itemId],
    );
    if (held === undefined) {
      throw new LocalChangeError('item_not_in_van', 'This part is not in your van.');
    }
    const vanLots = JSON.parse(held.lots ?? '[]') as {
      lotId: string;
      kind: 'serial' | 'batch';
      code: string;
      expiresOn: string | null;
    }[];
    const lots = checkLots(held.tracking, vanLots, input.quantity, input.lots ?? []);
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const materialId = uuidv7(now.getTime(), random);
    const payload = {
      materialId,
      itemId: input.itemId,
      quantity: input.quantity,
      ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
      ...(lots.length === 0 ? {} : { lots }),
      ...(input.allowExpired === true ? { allowExpired: true } : {}),
      item: {
        id: input.itemId,
        sku: held.sku,
        name: held.name,
        kind: held.kind as MaterialBody['item']['kind'],
        unit: held.unit as MaterialBody['item']['unit'],
        tracking: held.tracking as MaterialBody['item']['tracking'],
      },
      location: { id: held.location_id, name: held.location_name },
      // What the job shows until the server answers: the codes picked.
      lotLabels: lots.map((lot) => {
        const found = vanLots.find((candidate) => candidate.lotId === lot.lotId)!;
        return {
          lotId: lot.lotId,
          kind: found.kind,
          code: found.code,
          expiresOn: found.expiresOn,
          quantity: lot.quantity,
        };
      }),
    };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.material', payload }, at);
    await insertChange(sql, {
      id,
      kind: 'work_order.material',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return id;
  });
}

// ---------------------------------------------------------------------------
// Assets (CRM/ERP plan, phase E3; ADR-0008)
// ---------------------------------------------------------------------------

/**
 * Registers an asset found at the site of a job the engineer is on. It shows
 * on the phone at once, without a number or a tag until the server confirms
 * it, and is linked to the job. Returns the asset's id, chosen here.
 */
export async function recordAssetRegistered(
  context: ChangeContext,
  input: {
    workOrderId: string;
    name: string;
    make?: string | undefined;
    model?: string | undefined;
    serialNumber?: string | undefined;
    locationNote?: string | undefined;
    condition?: ConditionValue | undefined;
  },
): Promise<string> {
  const { db, clock, random } = context;
  const name = input.name.trim();
  if (name === '') {
    throw new LocalChangeError('name_required', 'Give the asset a name.');
  }
  return db.write(OUTBOX_TABLES, async (sql) => {
    const job = await jobDetail(sql, input.workOrderId);
    const now = clock.now();
    const at = now.toISOString();
    const assetId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    const actor = await actorOf(sql);
    const text = (value: string | undefined) =>
      value === undefined || value.trim() === '' ? undefined : value.trim();
    const payload = {
      workOrderId: input.workOrderId,
      name,
      ...(text(input.make) === undefined ? {} : { make: text(input.make) }),
      ...(text(input.model) === undefined ? {} : { model: text(input.model) }),
      ...(text(input.serialNumber) === undefined ? {} : { serialNumber: text(input.serialNumber) }),
      ...(text(input.locationNote) === undefined ? {} : { locationNote: text(input.locationNote) }),
      ...(input.condition === undefined ? {} : { condition: input.condition }),
    };
    const local: AssetSync = {
      asset: {
        id: assetId,
        reference: '',
        name,
        make: text(input.make) ?? null,
        model: text(input.model) ?? null,
        serialNumber: text(input.serialNumber) ?? null,
        status: 'active',
        condition: input.condition ?? null,
        customer: { id: job.customer.id, name: job.customer.name },
        site: { id: job.site.id, name: job.site.name },
        locationNote: text(input.locationNote) ?? null,
        warrantyExpiresOn: null,
        warranty: 'none',
        tagCode: '',
        tagLink: null,
        version: 0,
        item: null,
        installDate: null,
        notes: null,
        conditionRecordedAt: input.condition === undefined ? null : at,
        conditionRecordedBy: input.condition === undefined ? null : actor,
        createdBy: actor,
        createdAt: at,
        updatedAt: at,
        retiredAt: null,
        retiredBy: null,
      },
      workOrders: [],
      can: { edit: false, record: true, attach: false },
      carryOver: [],
      timeline: [
        {
          kind: 'event',
          id: mutationId,
          at,
          event: {
            kind: 'registered',
            fromSite: null,
            fromStatus: null,
            toStatus: null,
            condition: null,
            changes: null,
            workOrderId: input.workOrderId,
            note: null,
            by: actor,
          },
        },
      ],
    };
    await writeAsset(sql, local, [input.workOrderId], at, true);
    await insertChange(sql, {
      id: mutationId,
      kind: 'asset.register',
      entityKey: `asset:${assetId}`,
      entityId: assetId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return assetId;
  });
}

/** Records an asset's condition, on a job or not; it shows on the phone at once. */
export async function recordAssetCondition(
  context: ChangeContext,
  input: {
    assetId: string;
    condition: ConditionValue;
    note?: string | undefined;
    workOrderId?: string | undefined;
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const row = await sql.get<{ data: string }>('select data from assets where id = ?', [
      input.assetId,
    ]);
    if (row === undefined) {
      throw new LocalChangeError('asset_not_on_phone', 'This asset is not on this phone.');
    }
    const before = JSON.parse(row.data) as AssetSync;
    if (before.asset.status === 'retired') {
      throw new LocalChangeError('asset_retired', 'A retired asset takes no condition.');
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    const note = input.note === undefined || input.note.trim() === '' ? null : input.note.trim();
    await applyConditionLocally(sql, input.assetId, {
      id,
      condition: input.condition,
      note,
      workOrderId: input.workOrderId ?? null,
      at,
      actor: await actorOf(sql),
    });
    await insertChange(sql, {
      id,
      kind: 'asset.condition',
      entityKey: `asset:${input.assetId}`,
      entityId: input.assetId,
      workOrderId: input.workOrderId ?? null,
      payload: {
        condition: input.condition,
        ...(note === null ? {} : { note }),
        ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
      },
      // What the phone showed before, so dropping this change can put it back.
      base: {
        condition: before.asset.condition,
        conditionRecordedAt: before.asset.conditionRecordedAt,
        conditionRecordedBy: before.asset.conditionRecordedBy,
      },
      at,
    });
    return id;
  });
}

/** Says the job is for one of its site's assets too. */
export async function recordAssetLink(
  context: ChangeContext,
  input: { workOrderId: string; assetId: string },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const job = await jobDetail(sql, input.workOrderId);
    const asset = await sql.get<{ site_id: string; status: string }>(
      'select site_id, status from assets where id = ?',
      [input.assetId],
    );
    if (asset === undefined) {
      throw new LocalChangeError('asset_not_on_phone', 'This asset is not on this phone.');
    }
    if (asset.site_id !== job.site.id) {
      throw new LocalChangeError('asset_not_at_site', 'This asset is at another site.');
    }
    if (asset.status === 'retired') {
      throw new LocalChangeError('asset_retired', 'A retired asset is not linked to new work.');
    }
    const now = clock.now();
    const at = now.toISOString();
    const id = uuidv7(now.getTime(), random);
    await sql.run(
      'insert into asset_links (asset_id, work_order_id) values (?, ?) on conflict do nothing',
      [input.assetId, input.workOrderId],
    );
    // An asset registered here and not yet confirmed must reach the server first.
    const registration = await sql.get<{ id: string }>(
      `select id from outbox where kind = 'asset.register' and entity_id = ? and state <> 'done'`,
      [input.assetId],
    );
    await insertChange(sql, {
      id,
      kind: 'asset.link',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload: { assetId: input.assetId },
      base: null,
      ...(registration === undefined
        ? {}
        : { waitsFor: { media: [], mutations: [registration.id] } }),
      at,
    });
    return id;
  });
}

/** Undoes on the phone what a dropped asset change showed. */
async function discardAssetChange(sql: SqlConnection, row: OutboxRow): Promise<void> {
  if (row.kind === 'asset.register') {
    await sql.run('delete from asset_links where asset_id = ?', [row.entityId]);
    await sql.run('delete from assets where id = ? and local = 1', [row.entityId]);
  }
  if (row.kind === 'asset.condition' && row.base !== null) {
    const asset = await sql.get<{ data: string }>('select data from assets where id = ?', [
      row.entityId,
    ]);
    if (asset !== undefined) {
      const data = JSON.parse(asset.data) as AssetSync;
      const base = row.base as Pick<
        AssetSync['asset'],
        'condition' | 'conditionRecordedAt' | 'conditionRecordedBy'
      >;
      const next: AssetSync = {
        ...data,
        asset: { ...data.asset, ...base },
        timeline: data.timeline.filter((entry) => entry.id !== row.id),
      };
      await sql.run('update assets set data = ? where id = ?', [
        JSON.stringify(next),
        row.entityId,
      ]);
    }
  }
  if (row.kind === 'asset.link') {
    const assetId = (row.payload as { assetId?: string }).assetId;
    if (assetId !== undefined) {
      await sql.run('delete from asset_links where asset_id = ? and work_order_id = ?', [
        assetId,
        row.entityId,
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// Expense claims (seventh round; ADR-0010)
// ---------------------------------------------------------------------------

const AMOUNT = /^\d{1,16}(\.\d{1,4})?$/u;

/** The phone's own calendar date, `YYYY-MM-DD`: what "spent today or earlier" means where it is. */
export function deviceToday(now: Date): string {
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** What somebody claims from the phone; the receipts are photos already kept on it. */
export interface ExpenseClaimInput {
  categoryId: string;
  /** `YYYY-MM-DD`, today or earlier. */
  spentOn: string;
  /** A decimal string above zero, up to four places, in the company's currency. */
  amount: string;
  description: string;
  workOrderId?: string | undefined;
  receipts?: readonly { file: CapturedFileInput; title: string }[];
}

/** Queues one receipt for a claim, after the claim and after its own file. */
async function queueReceipt(
  sql: SqlConnection,
  context: ChangeContext,
  input: { claimId: string; file: CapturedFileInput; title: string; submittedBy: string | null },
  now: Date,
): Promise<{ attachmentId: string; mediaId: string }> {
  const at = now.toISOString();
  const mediaId = uuidv7(now.getTime(), context.random);
  const attachmentId = uuidv7(now.getTime(), context.random);
  await insertUpload(sql, { ...input.file, mediaId, workOrderId: null, at });
  const title = input.title.trim() === '' ? 'Receipt' : input.title.trim().slice(0, 200);
  await insertChange(sql, {
    id: uuidv7(now.getTime(), context.random),
    kind: 'expense.receipt',
    entityKey: `expense:${input.claimId}`,
    entityId: input.claimId,
    workOrderId: null,
    payload: { attachmentId, mediaId, title },
    base: null,
    // The claim must reach the server first, and the photo with it.
    waitsFor: {
      media: [mediaId],
      mutations: input.submittedBy === null ? [] : [input.submittedBy],
    },
    at,
  });
  return { attachmentId, mediaId };
}

/**
 * Claims an expense back from the phone, with photos of its receipts, signal
 * or not. The claim is checked here as the server would check it — a
 * category the phone was last told is in use, spent today or earlier, an
 * amount above zero, a description — so a refusal later is rare. It goes to
 * the server under the id chosen here, which makes a resend land once and
 * lets each receipt name it; each receipt follows once the claim has arrived
 * and its photo has uploaded. Returns that id.
 */
export async function recordExpenseClaim(
  context: ChangeContext,
  input: ExpenseClaimInput,
): Promise<{ claimId: string; mutationId: string }> {
  const { db, clock, random } = context;
  const amount = input.amount.trim();
  if (!AMOUNT.test(amount) || !/[1-9]/u.test(amount)) {
    throw new LocalChangeError('amount_invalid', 'Enter an amount above zero, such as 250.50.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.spentOn)) {
    throw new LocalChangeError('date_invalid', 'Give the date the money was spent.');
  }
  const description = input.description.trim();
  if (description === '' || description.length > 1000) {
    throw new LocalChangeError('description_required', 'Say what the expense was for.');
  }
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    if (input.spentOn > deviceToday(now)) {
      throw new LocalChangeError('spent_in_future', 'An expense is claimed once it is spent.');
    }
    const categories = await sql.get<{ value: string }>(
      `select value from meta where key = 'expense_categories'`,
    );
    const known =
      categories === undefined ? [] : (JSON.parse(categories.value) as { id: string }[]);
    if (!known.some((category) => category.id === input.categoryId)) {
      throw new LocalChangeError('category_unknown', 'Choose one of the categories in use.');
    }
    if (input.workOrderId !== undefined) {
      await jobDetail(sql, input.workOrderId);
    }
    const at = now.toISOString();
    const claimId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id: mutationId,
      kind: 'expense.submit',
      entityKey: `expense:${claimId}`,
      entityId: claimId,
      // Not the job's work: a claim never holds a job on the phone.
      workOrderId: null,
      payload: {
        categoryId: input.categoryId,
        spentOn: input.spentOn,
        amount,
        description,
        ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
      },
      base: null,
      at,
    });
    for (const receipt of input.receipts ?? []) {
      await queueReceipt(
        sql,
        context,
        { claimId, file: receipt.file, title: receipt.title, submittedBy: mutationId },
        now,
      );
    }
    return { claimId, mutationId };
  });
}

/**
 * Another receipt for a claim made on this phone, while the server still
 * takes receipts on it: it was submitted here and is not known to be decided.
 */
export async function recordExpenseReceipt(
  context: ChangeContext,
  input: { claimId: string; file: CapturedFileInput; title: string },
): Promise<{ attachmentId: string; mediaId: string }> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const submit = await sql.get<{ id: string; state: OutboxState }>(
      `select id, state from outbox where kind = 'expense.submit' and entity_id = ?
       order by seq desc limit 1`,
      [input.claimId],
    );
    if (submit === undefined) {
      throw new LocalChangeError('claim_not_on_phone', 'This claim was not made on this phone.');
    }
    return queueReceipt(
      sql,
      context,
      {
        claimId: input.claimId,
        file: input.file,
        title: input.title,
        submittedBy: submit.state === 'done' ? null : submit.id,
      },
      context.clock.now(),
    );
  });
}

/**
 * A claim dropped before the server took it takes its receipts with it: they
 * have nothing to belong to. Their uploads go too, when they have not started.
 */
async function discardExpenseChange(sql: SqlConnection, row: OutboxRow, at: string): Promise<void> {
  if (row.kind !== 'expense.submit') {
    return;
  }
  const receipts = await sql.all<{ seq: number; payload: string }>(
    `select seq, payload from outbox
     where kind = 'expense.receipt' and entity_key = ? and state <> 'done'`,
    [row.entityKey],
  );
  for (const receipt of receipts) {
    const { mediaId } = JSON.parse(receipt.payload) as { mediaId: string };
    await sql.run(
      `delete from uploads where media_id = ? and state <> 'confirmed' and bytes_sent = 0 and kind is null`,
      [mediaId],
    );
    await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
      at,
      JSON.stringify({ code: 'discarded', message: 'Its claim was discarded.' }),
      receipt.seq,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Parts bought from a merchant (eighth round; ADR-0012)
// ---------------------------------------------------------------------------

/** What the engineer bought for a job at a merchant; the receipts are photos already kept on the phone. */
export interface PurchaseInput {
  workOrderId: string;
  description: string;
  merchant?: string | undefined;
  /** A decimal string above zero, up to four places. */
  quantity: string;
  /** Paid for one, in the company currency: a decimal string, up to four places. */
  unitPrice: string;
  note?: string | undefined;
  receipts?: readonly { file: CapturedFileInput; title: string }[];
}

const QUANTITY = /^\d{1,16}(\.\d{1,4})?$/u;

/** Queues one receipt photo for a purchase, after the purchase and after its own file. */
async function queuePurchaseReceipt(
  sql: SqlConnection,
  context: ChangeContext,
  input: {
    purchaseId: string;
    workOrderId: string;
    file: CapturedFileInput;
    title: string;
    recordedBy: string | null;
  },
  now: Date,
): Promise<{ attachmentId: string; mediaId: string }> {
  const at = now.toISOString();
  const mediaId = uuidv7(now.getTime(), context.random);
  const attachmentId = uuidv7(now.getTime(), context.random);
  // Filed under the job, so the photo stays on the phone while the job does.
  await insertUpload(sql, { ...input.file, mediaId, workOrderId: input.workOrderId, at });
  const title = input.title.trim() === '' ? 'Receipt' : input.title.trim().slice(0, 200);
  await insertChange(sql, {
    id: uuidv7(now.getTime(), context.random),
    kind: 'work_order.purchase_receipt',
    entityKey: `purchase:${input.purchaseId}`,
    entityId: input.purchaseId,
    workOrderId: input.workOrderId,
    payload: { attachmentId, mediaId, title },
    base: null,
    // The purchase must reach the server first, and the photo with it. Should
    // the server still not have it, it answers `retry` (`purchase_not_ready`).
    waitsFor: {
      media: [mediaId],
      mutations: input.recordedBy === null ? [] : [input.recordedBy],
    },
    at,
  });
  return { attachmentId, mediaId };
}

/**
 * A part bought from a merchant for a job, with the price paid and a photo of
 * each receipt, signal or not (ADR-0012). Nothing enters stock: it is a
 * non-stock part used on the job, and paying the engineer back stays an
 * expense claim. The purchase goes with the job's other changes, under an id
 * chosen here so a resend lands once and each receipt can name it; each
 * receipt follows once the purchase has arrived and its photo has uploaded.
 */
export async function recordPurchase(
  context: ChangeContext,
  input: PurchaseInput,
): Promise<{ purchaseId: string; mutationId: string }> {
  const { db, clock, random } = context;
  const quantity = input.quantity.trim();
  if (!QUANTITY.test(quantity) || !/[1-9]/u.test(quantity)) {
    throw new LocalChangeError('quantity_invalid', 'Enter a quantity above zero.');
  }
  const unitPrice = input.unitPrice.trim();
  if (!AMOUNT.test(unitPrice)) {
    throw new LocalChangeError(
      'unit_price_invalid',
      'Enter the price paid for one, such as 85.50.',
    );
  }
  const description = input.description.trim();
  if (description === '' || description.length > 300) {
    throw new LocalChangeError('part_description_required', 'Say what was bought.');
  }
  const merchant = input.merchant?.trim().slice(0, 200) ?? '';
  const note = input.note?.trim().slice(0, 1000) ?? '';
  return db.write(OUTBOX_TABLES, async (sql) => {
    await jobDetail(sql, input.workOrderId);
    const now = clock.now();
    const at = now.toISOString();
    const purchaseId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id: mutationId,
      kind: 'work_order.purchase',
      // With the job's other changes, in the order they were made.
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload: {
        id: purchaseId,
        description,
        ...(merchant === '' ? {} : { merchant }),
        quantity,
        unitPrice,
        ...(note === '' ? {} : { note }),
      },
      base: null,
      at,
    });
    for (const receipt of input.receipts ?? []) {
      await queuePurchaseReceipt(
        sql,
        context,
        {
          purchaseId,
          workOrderId: input.workOrderId,
          file: receipt.file,
          title: receipt.title,
          recordedBy: mutationId,
        },
        now,
      );
    }
    return { purchaseId, mutationId };
  });
}

/** Another receipt photo for a purchase recorded on this phone. */
export async function recordPurchaseReceipt(
  context: ChangeContext,
  input: { purchaseId: string; file: CapturedFileInput; title: string },
): Promise<{ attachmentId: string; mediaId: string }> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const recorded = await sql.get<{ id: string; state: OutboxState; work_order_id: string }>(
      `select id, state, work_order_id from outbox
       where kind = 'work_order.purchase' and json_extract(payload, '$.id') = ?
       order by seq desc limit 1`,
      [input.purchaseId],
    );
    if (recorded === undefined) {
      throw new LocalChangeError(
        'purchase_not_on_phone',
        'This purchase was not recorded on this phone.',
      );
    }
    return queuePurchaseReceipt(
      sql,
      context,
      {
        purchaseId: input.purchaseId,
        workOrderId: recorded.work_order_id,
        file: input.file,
        title: input.title,
        recordedBy: recorded.state === 'done' ? null : recorded.id,
      },
      context.clock.now(),
    );
  });
}

/**
 * A purchase dropped before the server took it takes its receipts with it:
 * they have nothing to belong to. Their uploads go too, when they have not started.
 */
async function discardPurchaseChange(
  sql: SqlConnection,
  row: OutboxRow,
  at: string,
): Promise<void> {
  if (row.kind !== 'work_order.purchase' || typeof row.payload.id !== 'string') {
    return;
  }
  const receipts = await sql.all<{ seq: number; payload: string }>(
    `select seq, payload from outbox
     where kind = 'work_order.purchase_receipt' and entity_key = ? and state <> 'done'`,
    [`purchase:${row.payload.id}`],
  );
  for (const receipt of receipts) {
    const { mediaId } = JSON.parse(receipt.payload) as { mediaId: string };
    await sql.run(
      `delete from uploads where media_id = ? and state <> 'confirmed' and bytes_sent = 0 and kind is null`,
      [mediaId],
    );
    await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
      at,
      JSON.stringify({ code: 'discarded', message: 'Its purchase was discarded.' }),
      receipt.seq,
    ]);
  }
}

export async function recordComment(
  context: ChangeContext,
  input: { workOrderId: string; body: string; visibility: 'internal' | 'customer' },
): Promise<{ mutationId: string; commentId: string }> {
  const { db, clock, random } = context;
  const body = input.body.trim();
  // The server refuses an empty note; refusing it here keeps it out of the
  // outbox, where it would only wait to fail.
  if (body === '') {
    throw new LocalChangeError('note_required', 'Write the note first.');
  }
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const at = now.toISOString();
    const commentId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    const payload = { commentId, body, visibility: input.visibility };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.comment', payload }, at);
    await insertChange(sql, {
      id: mutationId,
      kind: 'work_order.comment',
      entityKey: `work_order:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      at,
    });
    return { mutationId, commentId };
  });
}

const ACCESS_COLUMNS = {
  gateCode: 'gate_code',
  parking: 'parking',
  askFor: 'ask_for',
  hazards: 'hazards',
  notes: 'access_notes',
} as const;

export async function recordAccessChange(
  context: ChangeContext,
  input: { siteId: string; changes: AccessValues },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const site = await sql.get<{ data: string }>('select data from sites where id = ?', [
      input.siteId,
    ]);
    if (site === undefined) {
      throw new LocalChangeError('site_not_on_phone', 'This site is not on this phone.');
    }
    const body = JSON.parse(site.data) as { access: Record<string, string | null> };
    const fields = (Object.keys(input.changes) as (keyof AccessValues)[]).filter(
      (field) => input.changes[field] !== undefined,
    );
    const now = clock.now();
    const at = now.toISOString();

    // Unsent edits to the same site's notes become one change, keeping what the
    // engineer first saw as its base. Never one already handed to the network:
    // its answer may be on its way back, and would mark this edit done unsent.
    const earlier = await sql.get<RawRow>(
      `select * from outbox where kind = 'site.access' and entity_id = ? and state = 'pending' and attempts = 0
         and sent_at is null
       order by seq desc limit 1`,
      [input.siteId],
    );
    const base: Record<string, string | null> = {};
    for (const field of fields) {
      base[field] = body.access[field] ?? null;
    }

    body.access = {
      ...body.access,
      ...Object.fromEntries(fields.map((field) => [field, input.changes[field] ?? null])),
    };
    await sql.run(
      `update sites set ${fields.map((field) => `${ACCESS_COLUMNS[field]} = ?`).join(', ')}${fields.length > 0 ? ', ' : ''}data = ? where id = ?`,
      [...fields.map((field) => input.changes[field] ?? null), JSON.stringify(body), input.siteId],
    );
    const jobs = await sql.all<{ id: string }>('select id from work_orders where site_id = ?', [
      input.siteId,
    ]);
    for (const job of jobs) {
      await applyLocally(
        sql,
        job.id,
        { kind: 'site.access', payload: { changes: input.changes } },
        at,
      );
    }

    if (earlier !== undefined) {
      const previous = toRow(earlier);
      const previousBase = (previous.base as { access: Record<string, string | null> }).access;
      const merged = {
        changes: { ...(previous.payload.changes as Record<string, unknown>), ...input.changes },
        base: { access: { ...base, ...previousBase } },
      };
      await sql.run('update outbox set payload = ?, base = ?, recorded_at = ? where seq = ?', [
        JSON.stringify({ changes: merged.changes }),
        JSON.stringify(merged.base),
        at,
        previous.seq,
      ]);
      return previous.id;
    }

    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'site.access',
      entityKey: `site:${input.siteId}`,
      entityId: input.siteId,
      workOrderId: jobs[0]?.id ?? null,
      payload: { changes: input.changes },
      base: { access: base },
      at,
    });
    return id;
  });
}

export async function recordFormStarted(
  context: ChangeContext,
  input: {
    formId: string;
    formVersionId: string;
    workOrderId: string | null;
    /** Filled for one of the job's assets (E3); with the answers carried over, if any. */
    assetId?: string;
    carriedOver?: { fromSubmissionId: string; fields: string[] };
  },
): Promise<{ mutationId: string; submissionId: string }> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const at = now.toISOString();
    const submissionId = uuidv7(now.getTime(), random);
    const mutationId = uuidv7(now.getTime(), random);
    await sql.run(
      `insert into submissions (id, form_id, form_version_id, work_order_id, status, answers, updated_at)
       values (?, ?, ?, ?, 'draft', '{}', ?)`,
      [submissionId, input.formId, input.formVersionId, input.workOrderId, at],
    );
    // An asset registered on this phone and not yet sent: the server must have
    // it before a form can be filled for it.
    const registration =
      input.assetId === undefined
        ? undefined
        : await sql.get<{ id: string }>(
            `select id from outbox where kind = 'asset.register' and entity_id = ? and state <> 'done'`,
            [input.assetId],
          );
    await insertChange(sql, {
      id: mutationId,
      kind: 'submission.start',
      entityKey: `submission:${submissionId}`,
      entityId: submissionId,
      workOrderId: input.workOrderId,
      payload: input,
      base: null,
      at,
      ...(registration === undefined
        ? {}
        : { waitsFor: { media: [], mutations: [registration.id] } }),
    });
    return { mutationId, submissionId };
  });
}

async function submissionRow(sql: SqlConnection, submissionId: string) {
  const row = await sql.get<{ work_order_id: string | null; status: string }>(
    'select work_order_id, status from submissions where id = ?',
    [submissionId],
  );
  if (row === undefined) {
    throw new LocalChangeError('form_not_on_phone', 'This form is not on this phone.');
  }
  return row;
}

/** Autosave. Unsent autosaves of the same form become one change. */
export async function recordAnswers(
  context: ChangeContext,
  input: { submissionId: string; answers: Record<string, unknown> },
): Promise<string> {
  const { db } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const submission = await submissionRow(sql, input.submissionId);
    if (submission.status === 'submitted') {
      throw new LocalChangeError('form_submitted', 'This form has been submitted.');
    }
    return saveAnswers(sql, context, {
      submissionId: input.submissionId,
      workOrderId: submission.work_order_id,
      answers: input.answers,
    });
  });
}

/** The autosave itself, inside a transaction the caller holds. */
async function saveAnswers(
  sql: SqlConnection,
  context: ChangeContext,
  input: { submissionId: string; workOrderId: string | null; answers: Record<string, unknown> },
): Promise<string> {
  const { clock, random } = context;
  const now = clock.now();
  const at = now.toISOString();
  await sql.run('update submissions set answers = ?, updated_at = ? where id = ?', [
    JSON.stringify(input.answers),
    at,
    input.submissionId,
  ]);
  const unsent = await sql.get<{ seq: number; id: string }>(
    `select seq, id from outbox
     where entity_key = ? and kind = 'submission.answers' and state = 'pending' and attempts = 0
       and sent_at is null
       and seq = (select max(seq) from outbox where entity_key = ? and state <> 'done')`,
    [`submission:${input.submissionId}`, `submission:${input.submissionId}`],
  );
  if (unsent !== undefined) {
    await sql.run('update outbox set payload = ?, recorded_at = ? where seq = ?', [
      JSON.stringify({ answers: input.answers }),
      at,
      unsent.seq,
    ]);
    return unsent.id;
  }
  const id = uuidv7(now.getTime(), random);
  await insertChange(sql, {
    id,
    kind: 'submission.answers',
    entityKey: `submission:${input.submissionId}`,
    entityId: input.submissionId,
    workOrderId: input.workOrderId,
    payload: { answers: input.answers },
    base: null,
    at,
  });
  return id;
}

/** Media ids named anywhere in a set of answers. */
export function mediaIdsIn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(mediaIdsIn);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const own = typeof record.mediaId === 'string' ? [record.mediaId] : [];
    return [...own, ...Object.values(record).flatMap(mediaIdsIn)];
  }
  return [];
}

export async function recordSubmit(
  context: ChangeContext,
  input: {
    submissionId: string;
    answers: Record<string, unknown>;
    /** The day it was filled, `YYYY-MM-DD`, in the engineer's calendar. */
    filledOn: string;
    reason?: string;
    /** Where the phone was, taken as the engineer submitted (P13). */
    location?: SubmitLocation;
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const submission = await submissionRow(sql, input.submissionId);
    const now = clock.now();
    const at = now.toISOString();
    await sql.run(
      `update submissions set answers = ?, status = 'submitted', submitted_at = ?, updated_at = ? where id = ?`,
      [JSON.stringify(input.answers), at, at, input.submissionId],
    );
    // A submit carries the final answers; an autosave that never left is superseded.
    // One that may have left stays, so the server's base moves with it.
    await sql.run(
      `delete from outbox where entity_key = ? and kind = 'submission.answers' and state = 'pending' and attempts = 0
       and sent_at is null`,
      [`submission:${input.submissionId}`],
    );
    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'submission.submit',
      entityKey: `submission:${input.submissionId}`,
      entityId: input.submissionId,
      workOrderId: submission.work_order_id,
      payload: {
        answers: input.answers,
        filledOn: input.filledOn,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.location === undefined ? {} : { location: input.location }),
      },
      base: null,
      waitsFor: { media: [...new Set(mediaIdsIn(input.answers))], mutations: [] },
      at,
    });
    return id;
  });
}

/**
 * Queues a file the engineer captured. Returns the id to put in the answer, which
 * the server will know the file by once it arrives.
 */
export async function queueUpload(
  context: ChangeContext,
  input: {
    localPath: string;
    contentType: string;
    byteSize: number;
    workOrderId: string | null;
    /** A small copy to show while it waits, made on the phone (P13). */
    thumbnailPath?: string;
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const mediaId = uuidv7(now.getTime(), random);
    await sql.run(
      `insert into uploads (media_id, local_path, thumbnail_path, content_type, byte_size, work_order_id, state, created_at)
       values (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      [
        mediaId,
        input.localPath,
        input.thumbnailPath ?? null,
        input.contentType,
        input.byteSize,
        input.workOrderId,
        now.toISOString(),
      ],
    );
    return mediaId;
  });
}

// ---------------------------------------------------------------------------
// The working day (P14)
// ---------------------------------------------------------------------------

export interface CapturedFileInput {
  /** Relative to the files directory. */
  localPath: string;
  thumbnailPath?: string;
  contentType: string;
  byteSize: number;
}

async function insertUpload(
  sql: SqlConnection,
  input: CapturedFileInput & { mediaId: string; workOrderId: string | null; at: string },
): Promise<void> {
  await sql.run(
    `insert into uploads (media_id, local_path, thumbnail_path, content_type, byte_size, work_order_id, state, created_at)
     values (?, ?, ?, ?, ?, ?, 'queued', ?)`,
    [
      input.mediaId,
      input.localPath,
      input.thumbnailPath ?? null,
      input.contentType,
      input.byteSize,
      input.workOrderId,
      input.at,
    ],
  );
}

/** Clocks in: a shift the phone keeps, and the server learns of when it can. */
export async function recordShiftStart(
  context: ChangeContext,
  input: { location: SubmitLocation | null },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const open = await sql.get<{ id: string }>('select id from shifts where ended_at is null');
    if (open !== undefined) {
      throw new LocalChangeError('shift_open', 'You are already clocked in.');
    }
    const now = clock.now();
    const at = now.toISOString();
    const shiftId = uuidv7(now.getTime(), random);
    await sql.run(
      `insert into shifts (id, started_at, ended_at, start_location, end_location, updated_at)
       values (?, ?, null, ?, null, ?)`,
      [shiftId, at, input.location === null ? null : JSON.stringify(input.location), at],
    );
    await insertChange(sql, {
      id: uuidv7(now.getTime(), random),
      kind: 'shift.start',
      entityKey: `shift:${shiftId}`,
      entityId: shiftId,
      workOrderId: null,
      payload: { startedAt: at, location: input.location },
      base: null,
      at,
    });
    return shiftId;
  });
}

export async function recordShiftEnd(
  context: ChangeContext,
  input: { shiftId: string; location: SubmitLocation | null },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const shift = await sql.get<{ ended_at: string | null }>(
      'select ended_at from shifts where id = ?',
      [input.shiftId],
    );
    if (shift?.ended_at !== null) {
      throw new LocalChangeError('shift_not_open', 'You are not clocked in.');
    }
    const now = clock.now();
    const at = now.toISOString();
    await sql.run('update shifts set ended_at = ?, end_location = ?, updated_at = ? where id = ?', [
      at,
      input.location === null ? null : JSON.stringify(input.location),
      at,
      input.shiftId,
    ]);
    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'shift.end',
      entityKey: `shift:${input.shiftId}`,
      entityId: input.shiftId,
      workOrderId: null,
      payload: { endedAt: at, location: input.location },
      base: null,
      at,
    });
    return id;
  });
}

/**
 * A before or after photo of a job. Queued for upload, shown on the job at once,
 * and added to the job on the server once the file has arrived. It has a record of
 * its own in the outbox, so a slow upload holds up nothing but the completion
 * that needs it.
 */
export async function recordPhoto(
  context: ChangeContext,
  input: { workOrderId: string; stage: 'before' | 'after'; file: CapturedFileInput },
): Promise<{ attachmentId: string; mediaId: string }> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    await jobDetail(sql, input.workOrderId);
    const now = clock.now();
    const at = now.toISOString();
    const mediaId = uuidv7(now.getTime(), random);
    const attachmentId = uuidv7(now.getTime(), random);
    await insertUpload(sql, { ...input.file, mediaId, workOrderId: input.workOrderId, at });
    const payload = {
      attachmentId,
      mediaId,
      stage: input.stage,
      title: input.stage === 'before' ? 'Before photo' : 'After photo',
      contentType: input.file.contentType,
      byteSize: input.file.byteSize,
    };
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.photo', payload }, at);
    await insertChange(sql, {
      id: uuidv7(now.getTime(), random),
      kind: 'work_order.photo',
      entityKey: `photo:${attachmentId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      waitsFor: { media: [mediaId], mutations: [] },
      at,
    });
    return { attachmentId, mediaId };
  });
}

/**
 * Takes a photo back off a job. One that never left the phone is simply dropped,
 * with its upload when that has not started; one the server has is removed there.
 * Returns local file paths the caller may delete.
 */
export async function recordPhotoRemoved(
  context: ChangeContext,
  input: { workOrderId: string; attachmentId: string },
): Promise<string[]> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const now = clock.now();
    const at = now.toISOString();
    await applyLocally(
      sql,
      input.workOrderId,
      { kind: 'work_order.photo_remove', payload: { attachmentId: input.attachmentId } },
      at,
    );
    const unsent = await sql.get<{ seq: number; payload: string }>(
      `select seq, payload from outbox
       where kind = 'work_order.photo' and entity_key = ? and state = 'pending' and sent_at is null`,
      [`photo:${input.attachmentId}`],
    );
    if (unsent !== undefined) {
      await sql.run('delete from outbox where seq = ?', [unsent.seq]);
      const { mediaId } = JSON.parse(unsent.payload) as { mediaId: string };
      const upload = await sql.get<{ local_path: string; thumbnail_path: string | null }>(
        `select local_path, thumbnail_path from uploads
         where media_id = ? and state <> 'confirmed' and bytes_sent = 0 and kind is null`,
        [mediaId],
      );
      if (upload === undefined) {
        return [];
      }
      await sql.run('delete from uploads where media_id = ?', [mediaId]);
      return upload.thumbnail_path === null
        ? [upload.local_path]
        : [upload.local_path, upload.thumbnail_path];
    }
    await insertChange(sql, {
      id: uuidv7(now.getTime(), random),
      kind: 'work_order.photo_remove',
      entityKey: `photo:${input.attachmentId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload: { attachmentId: input.attachmentId },
      base: null,
      at,
    });
    return [];
  });
}

/**
 * The customer's sign-off: a drawn signature with who signed, or why nobody
 * could. A later sign-off replaces an earlier one until the job is completed.
 */
export async function recordSignoff(
  context: ChangeContext,
  input: {
    workOrderId: string;
    signoff:
      | { signature: CapturedFileInput; name: string; role: string | null }
      | { unavailableReason: string };
  },
): Promise<string> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    await jobDetail(sql, input.workOrderId);
    const now = clock.now();
    const at = now.toISOString();
    let payload:
      | { mediaId: string; name: string; role: string | null; signedAt: string }
      | { unavailableReason: string; signedAt: string };
    const waitsFor: Waits = { media: [], mutations: [] };
    if ('signature' in input.signoff) {
      const mediaId = uuidv7(now.getTime(), random);
      await insertUpload(sql, {
        ...input.signoff.signature,
        mediaId,
        workOrderId: input.workOrderId,
        at,
      });
      payload = {
        mediaId,
        name: input.signoff.name.trim(),
        role:
          input.signoff.role === null || input.signoff.role.trim() === ''
            ? null
            : input.signoff.role.trim(),
        signedAt: at,
      };
      waitsFor.media = [mediaId];
    } else {
      payload = { unavailableReason: input.signoff.unavailableReason.trim(), signedAt: at };
    }
    await applyLocally(sql, input.workOrderId, { kind: 'work_order.signoff', payload }, at);
    const id = uuidv7(now.getTime(), random);
    await insertChange(sql, {
      id,
      kind: 'work_order.signoff',
      entityKey: `signoff:${input.workOrderId}`,
      entityId: input.workOrderId,
      workOrderId: input.workOrderId,
      payload,
      base: null,
      waitsFor,
      at,
    });
    return id;
  });
}

/**
 * Forms that reached the phone before sync existed (P11's drafts) are queued the
 * first time the engine runs: started on the server under the id they already
 * have, then given their answers.
 */
export async function adoptUnqueuedForms(context: ChangeContext): Promise<number> {
  const { db, clock, random } = context;
  return db.write(OUTBOX_TABLES, async (sql) => {
    const orphans = await sql.all<{
      id: string;
      form_id: string;
      form_version_id: string;
      work_order_id: string | null;
      answers: string;
    }>(
      `select id, form_id, form_version_id, work_order_id, answers from submissions
       where server_revision is null
         and id not in (select entity_id from outbox where kind like 'submission.%')`,
    );
    for (const orphan of orphans) {
      const now = clock.now();
      const at = now.toISOString();
      await insertChange(sql, {
        id: uuidv7(now.getTime(), random),
        kind: 'submission.start',
        entityKey: `submission:${orphan.id}`,
        entityId: orphan.id,
        workOrderId: orphan.work_order_id,
        payload: {
          formId: orphan.form_id,
          formVersionId: orphan.form_version_id,
          workOrderId: orphan.work_order_id,
        },
        base: null,
        at,
      });
      const answers = JSON.parse(orphan.answers) as Record<string, unknown>;
      if (Object.keys(answers).length > 0) {
        await insertChange(sql, {
          id: uuidv7(now.getTime(), random),
          kind: 'submission.answers',
          entityKey: `submission:${orphan.id}`,
          entityId: orphan.id,
          workOrderId: orphan.work_order_id,
          payload: { answers },
          base: null,
          at,
        });
      }
    }
    return orphans.length;
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function pendingRows(sql: SqlConnection): Promise<OutboxRow[]> {
  return (await sql.all<RawRow>(`select * from outbox where state <> 'done' order by seq`)).map(
    toRow,
  );
}

/**
 * The changes to send now, in order.
 *
 * A change goes when it is due, everything it waits for has arrived, and no
 * earlier change to the same record is still outstanding. Several changes to one
 * record can share a batch — the server applies them in order and holds back the
 * rest if one fails — except a form's answers, whose base is only known once the
 * change before them has been applied.
 */
export async function selectBatch(
  sql: SqlConnection,
  deviceNow: Date,
  limit = 50,
): Promise<{ rows: OutboxRow[]; mutations: PushMutation[] }> {
  const outstanding = await pendingRows(sql);
  if (outstanding.length === 0) {
    return { rows: [], mutations: [] };
  }
  const unconfirmed = new Set(
    (
      await sql.all<{ media_id: string }>(`select media_id from uploads where state <> 'confirmed'`)
    ).map((row) => row.media_id),
  );
  // A change waits on another by id. The wait holds while that id is on this
  // phone and not yet done. An id that is gone was an unsent change superseded
  // by a later one — an autosave by its submit, a photo by its removal — and
  // there is nothing left to wait for; holding on would strand the completion.
  const unfinishedMutations = new Set(
    (
      await sql.all<{ id: string }>(
        `select id from outbox where state <> 'done' and id in (select value from json_each(?))`,
        [JSON.stringify(outstanding.flatMap((row) => row.waitsFor.mutations))],
      )
    ).map((row) => row.id),
  );

  const blocked = new Set<string>();
  const included = new Map<string, number>();
  const rows: OutboxRow[] = [];
  const now = deviceNow.toISOString();

  for (const row of outstanding) {
    if (rows.length >= limit) {
      break;
    }
    if (blocked.has(row.entityKey)) {
      continue;
    }
    const due = row.nextAttemptAt === null || row.nextAttemptAt <= now;
    const waiting =
      row.waitsFor.media.some((mediaId) => unconfirmed.has(mediaId)) ||
      row.waitsFor.mutations.some((mutationId) => unfinishedMutations.has(mutationId));
    if (row.state !== 'pending' || !due || waiting) {
      blocked.add(row.entityKey);
      continue;
    }
    if (LAZY_BASE.has(row.kind) && (included.get(row.entityKey) ?? 0) > 0) {
      blocked.add(row.entityKey);
      continue;
    }
    rows.push(row);
    included.set(row.entityKey, (included.get(row.entityKey) ?? 0) + 1);
  }

  const mutations: PushMutation[] = [];
  for (const row of rows) {
    let base = row.base;
    if (LAZY_BASE.has(row.kind)) {
      const submission = await sql.get<{
        server_revision: number | null;
        server_answers: string | null;
      }>('select server_revision, server_answers from submissions where id = ?', [row.entityId]);
      base = {
        revision: submission?.server_revision ?? 1,
        answers:
          submission?.server_answers === null || submission?.server_answers === undefined
            ? {}
            : (JSON.parse(submission.server_answers) as Record<string, unknown>),
      };
    }
    mutations.push({
      id: row.id,
      kind: row.kind,
      entityId: row.entityId,
      recordedAt: row.recordedAt,
      payload: row.payload,
      ...(base === null ? {} : { base }),
    } as PushMutation);
  }
  return { rows, mutations };
}

/** After this many server-side failures a change stops retrying and asks for attention. */
export const MAX_ATTEMPTS = 10;

/** Seconds before the next try: 5, 10, 20… up to half an hour, or what the server asked for. */
export function backoffSeconds(attempts: number, retryAfterSeconds = 0): number {
  const exponential = Math.min(5 * 2 ** Math.max(0, attempts - 1), 30 * 60);
  return Math.max(exponential, retryAfterSeconds);
}

export interface PushCounts {
  pushed: number;
  conflicts: number;
  rejected: number;
  retried: number;
}

export async function applyPushResults(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  results: readonly PushResult[],
  deviceNow: Date,
): Promise<PushCounts> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const counts: PushCounts = { pushed: 0, conflicts: 0, rejected: 0, retried: 0 };
  const now = deviceNow.toISOString();

  for (const result of results) {
    const row = byId.get(result.id);
    if (row === undefined) {
      continue;
    }
    switch (result.outcome) {
      case 'applied':
        counts.pushed += 1;
        await sql.run(
          `update outbox set state = 'done', done_at = ?, last_error = null, conflict = null where seq = ?`,
          [now, row.seq],
        );
        if (row.kind.startsWith('submission.') && result.revision !== null) {
          await sql.run(
            'update submissions set server_revision = ?, server_answers = coalesce(?, server_answers) where id = ?',
            [
              result.revision,
              result.answers === null ? null : JSON.stringify(result.answers),
              row.entityId,
            ],
          );
          if (result.answers !== null && ANSWER_KINDS.has(row.kind)) {
            await absorbServerAnswers(sql, row, result.answers);
          }
        }
        break;
      case 'conflict':
        counts.conflicts += 1;
        await requestRefresh(sql, row.workOrderId);
        await sql.run(
          `update outbox set state = 'conflict', conflict = ?, last_error = ? where seq = ?`,
          [
            JSON.stringify(result.conflict),
            JSON.stringify({ code: result.code, message: result.message }),
            row.seq,
          ],
        );
        break;
      case 'rejected':
        counts.rejected += 1;
        await requestRefresh(sql, row.workOrderId);
        await sql.run(`update outbox set state = 'failed', last_error = ? where seq = ?`, [
          JSON.stringify({ code: result.code, message: result.message, details: result.details }),
          row.seq,
        ]);
        if (row.kind === 'submission.submit') {
          await unsubmitLocally(sql, row, now);
        }
        break;
      case 'retry': {
        counts.retried += 1;
        // Held back behind an earlier change is not a failure of this one.
        const attempts = result.code === 'blocked' ? row.attempts : row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await sql.run(
            `update outbox set state = 'failed', attempts = ?, last_error = ? where seq = ?`,
            [attempts, JSON.stringify({ code: 'gave_up', message: result.message }), row.seq],
          );
          break;
        }
        const wait =
          result.code === 'blocked' ? 0 : backoffSeconds(attempts, result.retryAfterSeconds);
        await sql.run(
          'update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where seq = ?',
          [
            attempts,
            new Date(deviceNow.getTime() + wait * 1000).toISOString(),
            JSON.stringify({ code: result.code, message: result.message }),
            row.seq,
          ],
        );
        break;
      }
    }
  }
  return counts;
}

/** Kinds whose payload carries a full set of answers. */
const ANSWER_KINDS: ReadonlySet<MutationKind> = new Set([
  'submission.answers',
  'submission.submit',
]);

/** Deep equality for JSON values. Key order does not matter: Postgres stores jsonb in its own. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a === null || b === null) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameJson(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Their changes on top of mine: every question the server changed since `base`
 * — another device's answer, merged in — takes the server's value, unless the
 * engineer changed that same question here since `base` too, in which case the
 * engineer's stands and goes with the next autosave. A question is one key: a
 * repeatable section's entries move as a whole.
 */
export function takeTheirs(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...mine };
  for (const key of new Set([...Object.keys(base), ...Object.keys(theirs)])) {
    if (!sameJson(theirs[key], base[key]) && sameJson(mine[key], base[key])) {
      setOrDelete(merged, key, theirs[key]);
    }
  }
  return merged;
}

/**
 * An applied autosave or submit came back with the answers the server now holds.
 * When those differ from what was sent, another device changed the form and the
 * server merged the two. The phone's copy, and any autosave still waiting to go,
 * were made against what was sent; left alone, the next autosave would carry the
 * other device's questions as they were before, against the merged base, and
 * quietly undo its work. So both take the server's merged answers, keeping only
 * what the engineer has changed here since.
 */
async function absorbServerAnswers(
  sql: SqlConnection,
  row: OutboxRow,
  theirs: Record<string, unknown>,
): Promise<void> {
  const base = (row.payload.answers ?? {}) as Record<string, unknown>;
  if (sameJson(base, theirs)) {
    return;
  }
  const local = await sql.get<{ answers: string }>('select answers from submissions where id = ?', [
    row.entityId,
  ]);
  if (local === undefined) {
    return;
  }
  const mine = JSON.parse(local.answers) as Record<string, unknown>;
  await sql.run('update submissions set answers = ? where id = ?', [
    JSON.stringify(takeTheirs(base, mine, theirs)),
    row.entityId,
  ]);
  // Only one change to a form is ever on the wire, so anything after this one
  // has not left and can still be corrected.
  const later = await sql.all<{ seq: number; payload: string }>(
    `select seq, payload from outbox
     where entity_key = ? and seq > ? and state = 'pending' and sent_at is null
       and kind in ('submission.answers', 'submission.submit')`,
    [row.entityKey, row.seq],
  );
  for (const change of later) {
    const payload = JSON.parse(change.payload) as { answers: Record<string, unknown> };
    await sql.run('update outbox set payload = ? where seq = ?', [
      JSON.stringify({ ...payload, answers: takeTheirs(base, payload.answers, theirs) }),
      change.seq,
    ]);
  }
}

/**
 * A submit the server refused, or the engineer dropped, never happened: the
 * form on the phone goes back to being the draft it was — or the correction, when
 * the submit carried a reason — with the engineer's answers kept as that draft.
 * Nothing is lost, the form opens for editing again, and the job no longer
 * counts it as done.
 */
async function unsubmitLocally(sql: SqlConnection, row: OutboxRow, at: string): Promise<void> {
  await sql.run(
    `update submissions set status = ?, submitted_at = null, updated_at = ?
     where id = ? and status = 'submitted'`,
    [row.payload.reason === undefined ? 'draft' : 'reopened', at, row.entityId],
  );
}

/** Marks changes as handed to the network, which ends folding later autosaves into them. */
export async function markSent(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  deviceNow: Date,
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await sql.run(`update outbox set sent_at = ? where seq in (select value from json_each(?))`, [
    deviceNow.toISOString(),
    JSON.stringify(rows.map((row) => row.seq)),
  ]);
}

/**
 * A batch that got no answer. With no connection the changes simply wait for the
 * next run; a server error counts as an attempt and backs off.
 */
export async function markBatchUnanswered(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
  deviceNow: Date,
  reason: 'offline' | 'server_error',
): Promise<void> {
  for (const row of rows) {
    if (reason === 'offline') {
      continue;
    }
    const attempts = row.attempts + 1;
    await sql.run(
      'update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where seq = ?',
      [
        attempts,
        new Date(deviceNow.getTime() + backoffSeconds(attempts) * 1000).toISOString(),
        JSON.stringify({
          code: 'server_error',
          message: 'The server could not take this change just now.',
        }),
        row.seq,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

async function outboxRow(sql: SqlConnection, mutationId: string): Promise<OutboxRow> {
  const raw = await sql.get<RawRow>('select * from outbox where id = ?', [mutationId]);
  if (raw === undefined) {
    throw new LocalChangeError('change_unknown', 'This change is not on this phone.');
  }
  return toRow(raw);
}

/** Sends the change again as a new change, in the same place in the order. */
async function reissue(
  sql: SqlConnection,
  context: ChangeContext,
  row: OutboxRow,
  update: { payload?: unknown; base?: unknown },
): Promise<string> {
  const now = context.clock.now();
  const id = uuidv7(now.getTime(), context.random);
  await sql.run(
    `update outbox set id = ?, state = 'pending', attempts = 0, next_attempt_at = null, last_error = null,
       conflict = null, payload = ?, base = ?, recorded_at = ?
     where seq = ?`,
    [
      id,
      JSON.stringify(update.payload ?? row.payload),
      update.base === undefined
        ? row.base === null
          ? null
          : JSON.stringify(row.base)
        : update.base === null
          ? null
          : JSON.stringify(update.base),
      now.toISOString(),
      row.seq,
    ],
  );
  // Whatever waited for this change by its old id waits for the new one. The
  // ids are quoted UUIDs inside JSON text, so a text replacement is exact.
  // Without this a completion recorded while the change was pending would wait
  // for an id no row will ever carry as done, and sit unsent for ever.
  await sql.run(
    `update outbox set waits_for = replace(waits_for, ?, ?) where state <> 'done' and instr(waits_for, ?) > 0`,
    [`"${row.id}"`, `"${id}"`, `"${row.id}"`],
  );
  return id;
}

/** Keep theirs: the change is dropped, and the next pull shows the server's version. */
export async function discardChange(context: ChangeContext, mutationId: string): Promise<void> {
  await context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    const at = context.clock.now().toISOString();
    await requestRefresh(sql, row.workOrderId);
    await discardAssetChange(sql, row);
    await discardExpenseChange(sql, row, at);
    await discardPurchaseChange(sql, row, at);
    await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
      at,
      JSON.stringify({
        code: 'discarded',
        message: 'Discarded by the engineer.',
        previous: row.lastError,
      }),
      row.seq,
    ]);
    // A dropped submit leaves the form a draft, as the server has it — unless the
    // server has it submitted by someone else, whose version the refresh brings.
    if (row.kind === 'submission.submit' && row.conflict?.kind !== 'already_submitted') {
      await unsubmitLocally(sql, row, at);
      if (row.state === 'failed') {
        // Refused, not outvoted: the answers were never the problem, so what the
        // engineer wrote goes on as the draft rather than vanishing with the submit.
        const local = await sql.get<{
          work_order_id: string | null;
          answers: string;
          server_answers: string | null;
        }>('select work_order_id, answers, server_answers from submissions where id = ?', [
          row.entityId,
        ]);
        if (local !== undefined) {
          const answers = JSON.parse(local.answers) as Record<string, unknown>;
          const known =
            local.server_answers === null
              ? {}
              : (JSON.parse(local.server_answers) as Record<string, unknown>);
          if (!sameJson(answers, known)) {
            await saveAnswers(sql, context, {
              submissionId: row.entityId,
              workOrderId: local.work_order_id,
              answers,
            });
          }
        }
      }
    }
  });
}

/** Try a refused or conflicting change again — after the engineer fixed what stood in its way. */
export async function retryChange(context: ChangeContext, mutationId: string): Promise<string> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    if (row.state === 'done') {
      throw new LocalChangeError('change_done', 'This change has already reached the server.');
    }
    const conflict = row.conflict;
    if (conflict?.kind === 'state_changed') {
      // Apply mine again, from the state the job is really in.
      return reissue(sql, context, row, {
        base: { state: conflict.current.state, revision: conflict.current.revision },
      });
    }
    if (row.lastError?.code === UPLOAD_FAILED && row.waitsFor.media.length > 0) {
      // The change was fine; a file it names was not. Trying the change again
      // means trying the file again, or it would only wait for ever.
      await sql.run(
        `update uploads set state = 'queued', attempts = 0, next_attempt_at = null, last_error = null
         where state = 'failed' and media_id in (select value from json_each(?))`,
        [JSON.stringify(row.waitsFor.media)],
      );
    }
    return reissue(sql, context, row, {});
  });
}

/** The error code on a change held up by a file that will not upload. */
export const UPLOAD_FAILED = 'upload_failed';

/**
 * A file that will never arrive — gone from the phone, unusable, or given up on
 * — strands every change waiting for it. Those changes fail with it, so they are
 * shown to the engineer to try again or drop, instead of reading "not sent yet"
 * for ever.
 */
export async function strandChangesWaitingFor(
  sql: SqlConnection,
  mediaId: string,
  code: string,
): Promise<number> {
  const result = await sql.run(
    `update outbox set state = 'failed', last_error = ?
     where state = 'pending'
       and exists (select 1 from json_each(waits_for, '$.media') where value = ?)`,
    [
      JSON.stringify({
        code: UPLOAD_FAILED,
        message: 'A file this change needs could not be uploaded.',
        details: { mediaId, code },
      }),
      mediaId,
    ],
  );
  return result.changes;
}

/** A file given another chance frees the changes that failed for want of it. */
export async function releaseChangesWaitingFor(sql: SqlConnection, mediaId: string): Promise<void> {
  await sql.run(
    `update outbox set state = 'pending', attempts = 0, next_attempt_at = null, last_error = null
     where state = 'failed' and json_extract(last_error, '$.code') = ?
       and exists (select 1 from json_each(waits_for, '$.media') where value = ?)`,
    [UPLOAD_FAILED, mediaId],
  );
}

export type Choice = 'mine' | 'theirs';

export async function resolveAccessConflict(
  context: ChangeContext,
  mutationId: string,
  choices: Readonly<Record<string, Choice>>,
): Promise<string | undefined> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    const conflict = row.conflict;
    if (conflict?.kind !== 'access_changed') {
      throw new LocalChangeError(
        'not_an_access_conflict',
        'This change is not an access-notes conflict.',
      );
    }
    const changes = { ...(row.payload.changes as Record<string, string | null>) };
    const base: Record<string, string | null> = {};
    const current = conflict.current as Record<string, string | null | undefined>;
    for (const field of Object.keys(changes)) {
      const disputed = conflict.fields.find((entry) => entry.field === field);
      if (disputed !== undefined && choices[field] !== 'mine') {
        delete changes[field];
        continue;
      }
      base[field] = current[field] ?? null;
    }
    if (Object.keys(changes).length === 0) {
      await sql.run(`update outbox set state = 'done', done_at = ?, last_error = ? where seq = ?`, [
        context.clock.now().toISOString(),
        JSON.stringify({ code: 'discarded', message: 'Kept the other version.' }),
        row.seq,
      ]);
      return undefined;
    }
    return reissue(sql, context, row, { payload: { changes }, base: { access: base } });
  });
}

export async function resolveAnswersConflict(
  context: ChangeContext,
  mutationId: string,
  choices: Readonly<Record<string, Choice>>,
): Promise<string> {
  return context.db.write(OUTBOX_TABLES, async (sql) => {
    const row = await outboxRow(sql, mutationId);
    const conflict = row.conflict;
    if (conflict?.kind !== 'answers_changed') {
      throw new LocalChangeError(
        'not_an_answers_conflict',
        'This change is not a conflict over answers.',
      );
    }
    const local = await sql.get<{ server_answers: string | null }>(
      'select server_answers from submissions where id = ?',
      [row.entityId],
    );
    const oldBase =
      local?.server_answers == null
        ? {}
        : (JSON.parse(local.server_answers) as Record<string, unknown>);
    const mine = row.payload.answers as Record<string, unknown>;
    const theirs = conflict.current.answers;
    const disputed = new Map(conflict.questions.map((question) => [question.id, question]));

    // Their version, with every change I made on top — and, where we both
    // changed the same question, whichever the engineer chose.
    const resolved: Record<string, unknown> = { ...theirs };
    for (const key of new Set([...Object.keys(mine), ...Object.keys(oldBase)])) {
      const question = disputed.get(key);
      if (question !== undefined) {
        if (choices[key] === 'mine') {
          setOrDelete(resolved, key, question.mine);
        }
        continue;
      }
      if (JSON.stringify(mine[key] ?? null) !== JSON.stringify(oldBase[key] ?? null)) {
        setOrDelete(resolved, key, mine[key]);
      }
    }

    await sql.run(
      'update submissions set answers = ?, server_revision = ?, server_answers = ? where id = ?',
      [JSON.stringify(resolved), conflict.current.revision, JSON.stringify(theirs), row.entityId],
    );
    return reissue(sql, context, row, { payload: { ...row.payload, answers: resolved } });
  });
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface SyncStatus {
  pendingChanges: number;
  conflicts: number;
  failed: number;
  pendingUploads: number;
  pendingUploadBytes: number;
  failedUploads: number;
  /** By the server's clock. */
  lastSuccessfulSyncAt: string | null;
}

export async function syncStatus(sql: SqlConnection): Promise<SyncStatus> {
  const row = await sql.get<{
    pending: number;
    conflicts: number;
    failed: number;
    uploads: number;
    upload_bytes: number;
    failed_uploads: number;
    last_success: string | null;
  }>(
    `select
       (select count(*) from outbox where state = 'pending') as pending,
       (select count(*) from outbox where state = 'conflict') as conflicts,
       (select count(*) from outbox where state = 'failed') as failed,
       (select count(*) from uploads where state = 'queued') as uploads,
       (select coalesce(sum(byte_size - bytes_sent), 0) from uploads where state = 'queued') as upload_bytes,
       (select count(*) from uploads where state = 'failed') as failed_uploads,
       (select value from meta where key = 'last_sync_success_at') as last_success`,
  );
  return {
    pendingChanges: row?.pending ?? 0,
    conflicts: row?.conflicts ?? 0,
    failed: row?.failed ?? 0,
    pendingUploads: row?.uploads ?? 0,
    pendingUploadBytes: row?.upload_bytes ?? 0,
    failedUploads: row?.failed_uploads ?? 0,
    lastSuccessfulSyncAt: row?.last_success ?? null,
  };
}

export interface JobSyncState {
  /** Everything done on this job has reached the server: nothing is left only on the phone. */
  safeToLeave: boolean;
  pendingChanges: number;
  pendingUploads: number;
  /** Changes that need the engineer: conflicts, refusals, and files that will not upload. */
  needsAttention: number;
}

export async function jobSyncState(sql: SqlConnection, workOrderId: string): Promise<JobSyncState> {
  const row = await sql.get<{
    pending: number;
    uploads: number;
    attention: number;
    unqueued: number;
  }>(
    `select
       (select count(*) from outbox where work_order_id = ?1 and state = 'pending') as pending,
       (select count(*) from uploads where work_order_id = ?1 and state = 'queued') as uploads,
       (select count(*) from outbox where work_order_id = ?1 and state in ('conflict', 'failed'))
       + (select count(*) from uploads where work_order_id = ?1 and state = 'failed') as attention,
       (select count(*) from submissions
        where work_order_id = ?1 and server_revision is null
          and id not in (select entity_id from outbox where kind like 'submission.%')) as unqueued`,
    [workOrderId],
  );
  const pendingChanges = (row?.pending ?? 0) + (row?.unqueued ?? 0);
  const pendingUploads = row?.uploads ?? 0;
  const needsAttention = row?.attention ?? 0;
  return {
    safeToLeave: pendingChanges === 0 && pendingUploads === 0 && needsAttention === 0,
    pendingChanges,
    pendingUploads,
    needsAttention,
  };
}

/** Changes that need the engineer, newest last, with enough to show them in words. */
export async function changesNeedingAttention(sql: SqlConnection): Promise<OutboxRow[]> {
  return (
    await sql.all<RawRow>(`select * from outbox where state in ('conflict', 'failed') order by seq`)
  ).map(toRow);
}

/** What a change was about, in words a person recognises. */
export interface DescribedChange extends OutboxRow {
  job: { id: string; referenceLabel: string; title: string } | null;
  formTitle: string | null;
  checklistLabel: string | null;
  siteName: string | null;
}

export async function describeChanges(
  sql: SqlConnection,
  rows: readonly OutboxRow[],
): Promise<DescribedChange[]> {
  const described: DescribedChange[] = [];
  for (const row of rows) {
    const job =
      row.workOrderId === null
        ? undefined
        : await sql.get<{ id: string; reference_label: string; title: string; data: string }>(
            'select id, reference_label, title, data from work_orders where id = ?',
            [row.workOrderId],
          );
    const detail = job === undefined ? undefined : (JSON.parse(job.data) as WorkOrderDetail);
    const form = row.kind.startsWith('submission.')
      ? await sql.get<{ title: string }>(
          `select forms.title from submissions join forms on forms.id = submissions.form_id
           where submissions.id = ?`,
          [row.entityId],
        )
      : undefined;
    const site =
      row.kind === 'site.access'
        ? await sql.get<{ name: string }>('select name from sites where id = ?', [row.entityId])
        : undefined;
    described.push({
      ...row,
      job:
        job === undefined
          ? null
          : { id: job.id, referenceLabel: job.reference_label, title: job.title },
      formTitle: form?.title ?? null,
      checklistLabel:
        row.kind === 'work_order.checklist'
          ? (detail?.checklist.find((item) => item.id === row.payload.itemId)?.label ?? null)
          : null,
      siteName: site?.name ?? null,
    });
  }
  return described;
}
