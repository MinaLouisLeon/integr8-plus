import {
  assetConditionSchema,
  assetEventKindSchema,
  assetStatusSchema,
  assetTagLink,
  ASSET_STATUSES,
  formatAssetReference,
  holds,
  newTagCode,
  type Principal,
  tagCodeOf,
  warrantyAlertDaysSchema,
  warrantyState,
} from '@integr8/core';
import { type Asset, type AssetEvent, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { itemSummary, itemSummarySchema } from './inventory.js';
import {
  attachmentBodies,
  attachmentSchema,
  many,
  mayWork,
  type People,
  peopleOf,
  personBody,
  personSchema,
  readableWorkOrder,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The machines a company services, their tags and their history (CRM/ERP
 * plan, phase E3; ADR-0008).
 *
 * Owners, admins and dispatchers manage the register. Engineers read the
 * assets of sites they have a job at, and may register one at a job's site,
 * record its condition and link it to the job — the machine is usually found
 * on site. Every change appends an immutable event; the timeline is read from
 * those events and from the jobs, submissions, parts and files the asset is
 * named on, or whose job it is the only asset of.
 */

const TAGS = ['assets'];
const ASSETS = 'assets' as const;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const placeSchema = z.object({ id: z.uuid(), name: z.string() });

export const assetSummarySchema = z.object({
  id: z.uuid(),
  /** `AS-000123`. */
  reference: z.string(),
  name: z.string(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  status: assetStatusSchema,
  condition: assetConditionSchema.nullable(),
  customer: placeSchema,
  site: placeSchema,
  locationNote: z.string().nullable(),
  warrantyExpiresOn: z.iso.date().nullable(),
  /** Against the company's warning window, on the company's today. */
  warranty: z.enum(['none', 'covered', 'expiring', 'expired']),
  tagCode: z.string(),
  /** What the printed QR code holds; null until the web app's address is configured. */
  tagLink: z.string().nullable(),
  version: z.number().int(),
});

export const assetSchema = assetSummarySchema.extend({
  item: itemSummarySchema.nullable(),
  installDate: z.iso.date().nullable(),
  notes: z.string().nullable(),
  conditionRecordedAt: z.iso.datetime().nullable(),
  conditionRecordedBy: personSchema.nullable(),
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
  retiredBy: personSchema.nullable(),
});

export const assetDetailSchema = z.object({
  asset: assetSchema,
  /** The jobs it is linked to, newest link first. */
  workOrders: z.array(workOrderSummarySchema.extend({ linkedAt: z.iso.datetime() })),
  can: z.object({
    edit: z.boolean(),
    record: z.boolean(),
    attach: z.boolean(),
  }),
});

const eventEntry = z.object({
  kind: z.literal('event'),
  id: z.uuid(),
  at: z.iso.datetime(),
  event: z.object({
    kind: assetEventKindSchema,
    fromSite: placeSchema.extend({ customer: placeSchema }).nullable(),
    fromStatus: assetStatusSchema.nullable(),
    toStatus: assetStatusSchema.nullable(),
    condition: assetConditionSchema.nullable(),
    /** Edits: each field that changed, before and after. */
    changes: z.record(z.string(), z.tuple([z.unknown(), z.unknown()])).nullable(),
    workOrderId: z.uuid().nullable(),
    note: z.string().nullable(),
    by: personSchema,
  }),
});

const jobEntry = z.object({
  kind: z.literal('job'),
  id: z.uuid(),
  /** When the job was linked to the asset. */
  at: z.iso.datetime(),
  workOrder: workOrderSummarySchema,
});

const submissionEntry = z.object({
  kind: z.literal('submission'),
  id: z.uuid(),
  at: z.iso.datetime(),
  submission: z.object({
    id: z.uuid(),
    form: placeSchema,
    workOrderId: z.uuid().nullable(),
    status: z.string(),
    /** False when it is the asset's because its job has no other asset. */
    explicit: z.boolean(),
    by: personSchema,
    /** Images answered on it, for thumbnails. */
    photos: z.array(z.object({ mediaId: z.uuid(), contentType: z.string() })),
  }),
});

const partEntry = z.object({
  kind: z.literal('part'),
  id: z.uuid(),
  at: z.iso.datetime(),
  part: z.object({
    item: itemSummarySchema,
    quantity: z.string(),
    returnedQuantity: z.string(),
    workOrderId: z.uuid(),
    explicit: z.boolean(),
    by: personSchema,
  }),
});

const attachmentEntry = z.object({
  kind: z.literal('attachment'),
  id: z.uuid(),
  at: z.iso.datetime(),
  attachment: attachmentSchema.extend({ workOrderId: z.uuid().nullable() }),
});

export const timelineEntrySchema = z.discriminatedUnion('kind', [
  eventEntry,
  jobEntry,
  submissionEntry,
  partEntry,
  attachmentEntry,
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

const settingsSchema = z.object({
  warrantyAlertDays: z.number().int(),
  version: z.number().int(),
  can: z.object({ edit: z.boolean() }),
});

// ---------------------------------------------------------------------------
// Access and shaping
// ---------------------------------------------------------------------------

/** Engineers see the assets of sites they are on a job at; everyone else every asset. */
function seesAll(principal: Principal): boolean {
  return holds(principal, 'work_order.read_all');
}

export async function readableAsset(
  tx: TenantTransaction,
  principal: Principal,
  assetId: string,
): Promise<Asset> {
  const asset = await tx.assets.find(assetId);
  if (
    asset === undefined ||
    (!seesAll(principal) && !(await tx.assets.personHasSite(principal.userId, asset.siteId)))
  ) {
    throw notFound('This asset does not exist.');
  }
  return asset;
}

export async function assetSummaries(
  tx: TenantTransaction,
  assets: readonly Asset[],
  webAppUrl: string | undefined,
): Promise<z.infer<typeof assetSummarySchema>[]> {
  const [customers, sites, settings, today] = await Promise.all([
    tx.customers.findMany([...new Set(assets.map((asset) => asset.customerId))]),
    tx.sites.findMany([...new Set(assets.map((asset) => asset.siteId))]),
    tx.assets.settings(),
    companyToday(tx),
  ]);
  const customer = new Map(customers.map((row) => [row.id, row.name]));
  const site = new Map(sites.map((row) => [row.id, row.name]));
  return assets.map((asset) => ({
    id: asset.id,
    reference: formatAssetReference(asset.reference),
    name: asset.name,
    make: asset.make,
    model: asset.model,
    serialNumber: asset.serialNumber,
    status: asset.status,
    condition: asset.condition,
    customer: { id: asset.customerId, name: customer.get(asset.customerId) ?? '' },
    site: { id: asset.siteId, name: site.get(asset.siteId) ?? '' },
    locationNote: asset.locationNote,
    warrantyExpiresOn: asset.warrantyExpiresOn,
    warranty:
      asset.status === 'retired'
        ? 'none'
        : warrantyState(asset.warrantyExpiresOn, today, settings.warrantyAlertDays),
    tagCode: asset.tagCode,
    tagLink: webAppUrl === undefined ? null : assetTagLink(webAppUrl, asset.tagCode),
    version: asset.version,
  }));
}

async function assetDetail(
  tx: TenantTransaction,
  context: RequestContext,
  asset: Asset,
): Promise<z.infer<typeof assetDetailSchema>> {
  const { principal } = context;
  const [[summary], people, items, links] = await Promise.all([
    assetSummaries(tx, [asset], context.config.WEB_APP_URL),
    peopleOf(tx),
    asset.itemId === null ? Promise.resolve([]) : tx.inventoryCatalogue.findItems([asset.itemId]),
    tx.assets.linksOfAsset(asset.id),
  ]);
  const jobs = await visibleJobs(
    tx,
    principal,
    links.map((link) => link.workOrderId),
  );
  const summaries = new Map(
    (await workOrderSummaries(tx, jobs, people)).map((job) => [job.id, job]),
  );
  const retired = asset.status === 'retired';
  return {
    asset: {
      ...summary!,
      item: items[0] === undefined ? null : itemSummary(items[0]),
      installDate: asset.installDate,
      notes: asset.notes,
      conditionRecordedAt: isoOrNull(asset.conditionRecordedAt),
      conditionRecordedBy:
        asset.conditionRecordedBy === null ? null : personBody(asset.conditionRecordedBy, people),
      createdBy: personBody(asset.createdBy, people),
      createdAt: iso(asset.createdAt),
      updatedAt: iso(asset.updatedAt),
      retiredAt: isoOrNull(asset.retiredAt),
      retiredBy: asset.retiredBy === null ? null : personBody(asset.retiredBy, people),
    },
    workOrders: links.flatMap((link) => {
      const job = summaries.get(link.workOrderId);
      return job === undefined ? [] : [{ ...job, linkedAt: iso(link.linkedAt) }];
    }),
    can: {
      edit: holds(principal, 'asset.manage'),
      record: holds(principal, 'asset.record') && !retired,
      attach: holds(principal, 'asset.record'),
    },
  };
}

/** The jobs among these the person may see: all of them for the office, their own for an engineer. */
async function visibleJobs(tx: TenantTransaction, principal: Principal, ids: readonly string[]) {
  const jobs = await tx.workOrders.findMany([...new Set(ids)]);
  if (seesAll(principal)) {
    return jobs;
  }
  const mine = await Promise.all(
    jobs.map(async (job) =>
      (await tx.workOrders.isAssigned(job.id, principal.userId)) ? job : undefined,
    ),
  );
  return mine.filter((job) => job !== undefined);
}

/** Image references anywhere in a submission's answers. */
function photosIn(value: unknown, found: { mediaId: string; contentType: string }[] = []) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      photosIn(entry, found);
    }
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (
      typeof record.mediaId === 'string' &&
      typeof record.contentType === 'string' &&
      record.contentType.startsWith('image/')
    ) {
      found.push({ mediaId: record.mediaId, contentType: record.contentType });
    } else {
      for (const entry of Object.values(record)) {
        photosIn(entry, found);
      }
    }
  }
  return found;
}

function eventEntryOf(
  event: AssetEvent,
  people: People,
  places: Map<string, { site: string; customer: string }>,
): TimelineEntry {
  const from = event.fromSiteId === null ? undefined : places.get(event.fromSiteId);
  return {
    kind: 'event',
    id: event.id,
    at: iso(event.occurredAt),
    event: {
      kind: event.kind,
      fromSite:
        event.fromSiteId === null || event.fromCustomerId === null
          ? null
          : {
              id: event.fromSiteId,
              name: from?.site ?? '',
              customer: { id: event.fromCustomerId, name: from?.customer ?? '' },
            },
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      condition: event.condition,
      changes: event.changes,
      workOrderId: event.workOrderId,
      note: event.note,
      by: personBody(event.actorId, people),
    },
  };
}

/**
 * Everything the asset has been through, newest first. Records of jobs this
 * person may not see are left out, so an engineer reads what their own jobs
 * and the asset's own events say.
 */
export async function assetTimeline(
  tx: TenantTransaction,
  principal: Principal,
  asset: Asset,
): Promise<TimelineEntry[]> {
  const [events, links, submissions, parts, attachments, people] = await Promise.all([
    tx.assets.events(asset.id),
    tx.assets.linksOfAsset(asset.id),
    tx.assets.submissionsOf(asset.id),
    tx.assets.partsOf(asset.id),
    tx.assets.attachmentsOf(asset.id),
    peopleOf(tx),
  ]);
  const jobIds = [
    ...links.map((link) => link.workOrderId),
    ...submissions.flatMap((row) => (row.workOrderId === null ? [] : [row.workOrderId])),
    ...parts.map((row) => row.workOrderId),
    ...attachments.flatMap((row) => ('workOrderId' in row.owner ? [row.owner.workOrderId] : [])),
  ];
  const jobs = await visibleJobs(tx, principal, jobIds);
  const visible = new Set(jobs.map((job) => job.id));
  const seen = (workOrderId: string | null) => workOrderId === null || visible.has(workOrderId);
  const fromSites = [
    ...new Set(events.flatMap((event) => (event.fromSiteId === null ? [] : [event.fromSiteId]))),
  ];
  const [sites, forms, items, summaries, attachmentRows] = await Promise.all([
    tx.sites.findMany(fromSites),
    tx.forms.listForms(),
    tx.inventoryCatalogue.findItems([...new Set(parts.map((part) => part.itemId))]),
    workOrderSummaries(tx, jobs, people),
    attachmentBodies(
      tx,
      attachments.filter((row) => seen('workOrderId' in row.owner ? row.owner.workOrderId : null)),
      people,
    ),
  ]);
  const customers = new Map(
    (await tx.customers.findMany([...new Set(sites.map((site) => site.customerId))])).map((row) => [
      row.id,
      row.name,
    ]),
  );
  const places = new Map(
    sites.map((site) => [
      site.id,
      { site: site.name, customer: customers.get(site.customerId) ?? '' },
    ]),
  );
  const formTitle = new Map(forms.map((form) => [form.id, form.title]));
  const item = new Map(items.map((row) => [row.id, row]));
  const job = new Map(summaries.map((row) => [row.id, row]));
  const attachmentJob = new Map(
    attachments.map((row) => [row.id, 'workOrderId' in row.owner ? row.owner.workOrderId : null]),
  );

  const entries: TimelineEntry[] = [
    ...events.map((event) => eventEntryOf(event, people, places)),
    ...links.flatMap((link): TimelineEntry[] => {
      const summary = job.get(link.workOrderId);
      return summary === undefined
        ? []
        : [{ kind: 'job', id: link.workOrderId, at: iso(link.linkedAt), workOrder: summary }];
    }),
    ...submissions
      .filter((row) => seen(row.workOrderId))
      .map((row): TimelineEntry => ({
        kind: 'submission',
        id: row.id,
        at: iso(row.submittedAt),
        submission: {
          id: row.id,
          form: { id: row.formId, name: formTitle.get(row.formId) ?? '' },
          workOrderId: row.workOrderId,
          status: row.status,
          explicit: row.explicit,
          by: personBody(row.submittedBy, people),
          photos: photosIn(row.answers),
        },
      })),
    ...parts
      .filter((row) => seen(row.workOrderId) && item.has(row.itemId))
      .map((row): TimelineEntry => ({
        kind: 'part',
        id: row.id,
        at: iso(row.occurredAt),
        part: {
          item: itemSummary(item.get(row.itemId)!),
          quantity: row.quantity,
          returnedQuantity: row.returnedQuantity,
          workOrderId: row.workOrderId,
          explicit: row.explicit,
          by: personBody(row.recordedBy, people),
        },
      })),
    ...attachmentRows.map((row): TimelineEntry => ({
      kind: 'attachment',
      id: row.id,
      at: row.createdAt,
      attachment: { ...row, workOrderId: attachmentJob.get(row.id) ?? null },
    })),
  ];
  return entries.sort((a, b) =>
    a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at),
  );
}

function serialTaken(field: string, existing: Asset | undefined): never {
  throw unprocessable('serial_taken', 'Another asset already has this serial number.', [
    {
      field,
      code: 'serial_taken',
      message: 'Serial numbers are unique within the company.',
      ...(existing === undefined
        ? {}
        : {
            params: { assetId: existing.id, reference: formatAssetReference(existing.reference) },
          }),
    },
  ]);
}

/**
 * Refuses a serial another asset holds, before writing: a refused insert
 * aborts the transaction, so the check comes first and the constraint only
 * catches a race.
 */
async function requireFreeSerial(
  tx: TenantTransaction,
  serial: string | null | undefined,
  self: string | undefined,
): Promise<void> {
  if (serial === undefined || serial === null || serial.trim() === '') {
    return;
  }
  const holder = await tx.assets.findBySerial(serial);
  if (holder !== undefined && holder.id !== self) {
    serialTaken('body.serialNumber', holder);
  }
}

/** A fresh tag code nobody holds; a collision of 60 random bits is retried, not trusted. */
async function freshTagCode(tx: TenantTransaction): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newTagCode();
    if ((await tx.assets.findByTag(code)) === undefined) {
      return code;
    }
  }
  throw new Error('Could not mint a fresh tag code');
}

// ---------------------------------------------------------------------------
// Routes: the register
// ---------------------------------------------------------------------------

const assetParams = z.object({ assetId: z.uuid() });
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const detailsSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  make: optionalText(200),
  model: optionalText(200),
  serialNumber: optionalText(200),
  itemId: z.uuid().nullable().optional(),
  locationNote: optionalText(500),
  installDate: z.iso.date().nullable().optional(),
  warrantyExpiresOn: z.iso.date().nullable().optional(),
  notes: optionalText(2000),
});

export const listAssetsRoute = defineRoute({
  method: 'get',
  path: '/v1/assets',
  operationId: 'listAssets',
  summary: 'Find assets',
  description:
    'Newest first. `q` matches a reference (`AS-000123`), a tag code, a serial, the name, make, model or place on site, or words of the customer’s name. `warranty=expiring` keeps those ending within the company’s warning window, `expired` those already ended. Engineers see the assets of sites they are on a job at.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    customerId: z.uuid().optional(),
    siteId: z.uuid().optional(),
    status: many(assetStatusSchema, ASSET_STATUSES.length),
    warranty: z.enum(['expiring', 'expired']).optional(),
    cursor: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of assets.',
      schema: z.object({ items: z.array(assetSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      let window: { warrantyEndsBy: string; warrantyEndsFrom?: string } | undefined;
      if (query.warranty !== undefined) {
        const [today, settings] = await Promise.all([companyToday(tx), tx.assets.settings()]);
        if (query.warranty === 'expired') {
          const yesterday = new Date(`${today}T00:00:00Z`);
          yesterday.setUTCDate(yesterday.getUTCDate() - 1);
          window = { warrantyEndsBy: yesterday.toISOString().slice(0, 10) };
        } else {
          const horizon = new Date(`${today}T00:00:00Z`);
          horizon.setUTCDate(horizon.getUTCDate() + settings.warrantyAlertDays);
          window = { warrantyEndsBy: horizon.toISOString().slice(0, 10), warrantyEndsFrom: today };
        }
      }
      const page = await tx.assets.list({
        ...(query.q === undefined ? {} : { text: query.q }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
        ...(query.status.length === 0 ? {} : { statuses: query.status }),
        ...(window ?? {}),
        ...(seesAll(principal) ? {} : { visibleTo: principal.userId }),
        ...(query.cursor === undefined ? {} : { before: query.cursor }),
        limit: query.limit,
      });
      return {
        items: await assetSummaries(tx, page.items, context.config.WEB_APP_URL),
        nextCursor: page.next === undefined ? null : String(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const createAssetRoute = defineRoute({
  method: 'post',
  path: '/v1/assets',
  operationId: 'createAsset',
  summary: 'Register an asset',
  description:
    'At a site, or at the site of `workOrderId`, which also links it to that job. Engineers register only at the site of a job they are working (422 `work_order_required` without one). A serial already in the company is 422 `serial_taken`. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.record',
  feature: ASSETS,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: detailsSchema.extend({
    name: z.string().trim().min(1).max(200),
    siteId: z.uuid().optional(),
    workOrderId: z.uuid().optional(),
    condition: assetConditionSchema.optional(),
  }),
  responses: {
    201: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such site, job or item.' },
    422: { description: 'No site, a serial already used, or an engineer without a job.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const manages = holds(principal, 'asset.manage');
      let siteId = body.siteId;
      const job =
        body.workOrderId === undefined
          ? undefined
          : await readableWorkOrder(tx, principal, body.workOrderId);
      if (job !== undefined) {
        if (!manages && !(await mayWork(tx, principal, job))) {
          throw notFound('This work order does not exist.');
        }
        if (siteId !== undefined && siteId !== job.siteId) {
          throw unprocessable(
            'site_not_job_site',
            'An asset registered on a job is at the job’s site.',
            [
              {
                field: 'body.siteId',
                code: 'site_not_job_site',
                message: 'Leave it out, or use the job’s site.',
              },
            ],
          );
        }
        siteId = job.siteId;
      } else if (!manages) {
        throw unprocessable('work_order_required', 'Register an asset from one of your jobs.', [
          {
            field: 'body.workOrderId',
            code: 'work_order_required',
            message: 'Name the job you are on.',
          },
        ]);
      }
      if (siteId === undefined) {
        throw unprocessable('site_required', 'Say which site the asset is at.', [
          { field: 'body.siteId', code: 'site_required', message: 'A site, or a job at one.' },
        ]);
      }
      const site = await tx.sites.find(siteId);
      if (site === undefined) {
        throw notFound('This site does not exist.');
      }
      if (body.itemId !== undefined && body.itemId !== null) {
        if ((await tx.inventoryCatalogue.findItems([body.itemId])).length === 0) {
          throw notFound('This item does not exist.');
        }
      }
      await requireFreeSerial(tx, body.serialNumber, undefined);
      const { workOrderId: _job, siteId: _site, condition, ...details } = body;
      const result = await tx.assets.register(
        {
          ...details,
          customerId: site.customerId,
          siteId: site.id,
          tagCode: await freshTagCode(tx),
          ...(condition === undefined ? {} : { condition }),
        },
        principal.userId,
        { workOrderId: job?.id },
      );
      if (result === 'serial_taken') {
        // Another request took the serial between the check and the insert.
        serialTaken('body.serialNumber', undefined);
      }
      if (job !== undefined) {
        await tx.assets.link(job.id, result.asset.id, principal.userId);
      }
      await audit(tx, context, 'asset.registered', 'asset', result.asset.id, {
        reference: formatAssetReference(result.asset.reference),
        siteId: site.id,
        ...(job === undefined ? {} : { workOrderId: job.id }),
      });
      return assetDetail(tx, context, result.asset);
    });
    return { status: 201, body: detail };
  },
});

export const assetByTagRoute = defineRoute({
  method: 'get',
  path: '/v1/assets/by-tag/:code',
  operationId: 'findAssetByTag',
  summary: 'Open an asset from its tag',
  description:
    'The code as printed, typed (case, dashes and look-alike letters forgiven) or the whole scanned link. 404 for a code of another company, an old tag or anything unknown, alike.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: z.object({ code: z.string().trim().min(1).max(500) }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The asset.', schema: z.object({ id: z.uuid(), reference: z.string() }) },
    404: { description: 'No asset with this tag.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const code = tagCodeOf(params.code);
      const found = code === undefined ? undefined : await tx.assets.findByTag(code);
      if (found === undefined) {
        throw notFound('No asset has this tag.');
      }
      const asset = await readableAsset(tx, principal, found.id);
      return { id: asset.id, reference: formatAssetReference(asset.reference) };
    });
    return { status: 200, body };
  },
});

export const getAssetRoute = defineRoute({
  method: 'get',
  path: '/v1/assets/:assetId',
  operationId: 'getAsset',
  summary: 'An asset, with the jobs it is linked to',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset, or not one of this engineer’s sites.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) =>
      assetDetail(tx, context, await readableAsset(tx, principal, params.assetId)),
    );
    return { status: 200, body };
  },
});

export const assetTimelineRoute = defineRoute({
  method: 'get',
  path: '/v1/assets/:assetId/timeline',
  operationId: 'getAssetTimeline',
  summary: 'Everything an asset has been through',
  description:
    'Newest first: its own events, the jobs linked to it, and the submissions, parts and files that name it or whose job has no other asset. An engineer sees the records of their own jobs.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The timeline.',
      schema: z.object({ entries: z.array(timelineEntrySchema) }),
    },
    404: { description: 'No such asset.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => ({
      entries: await assetTimeline(
        tx,
        principal,
        await readableAsset(tx, principal, params.assetId),
      ),
    }));
    return { status: 200, body };
  },
});

export const updateAssetRoute = defineRoute({
  method: 'patch',
  path: '/v1/assets/:assetId',
  operationId: 'updateAsset',
  summary: 'Change an asset’s details',
  description:
    'Each field given replaces the old one; one `updated` event records what changed, before and after. `expectedVersion` (409 `version_conflict`); a serial already used is 422 `serial_taken`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: detailsSchema.extend({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset or item.' },
    409: { description: 'Changed elsewhere.' },
    422: { description: 'A serial already used.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const asset = await readableAsset(tx, principal, params.assetId);
      if (body.itemId !== undefined && body.itemId !== null) {
        if ((await tx.inventoryCatalogue.findItems([body.itemId])).length === 0) {
          throw notFound('This item does not exist.');
        }
      }
      await requireFreeSerial(tx, body.serialNumber, asset.id);
      const { expectedVersion, ...details } = body;
      const result = await tx.assets.update(asset.id, expectedVersion, details, principal.userId);
      if (result === 'version_conflict') {
        throw conflict('version_conflict', 'This asset was changed by someone else. Reload it.');
      }
      if (result === 'serial_taken') {
        serialTaken('body.serialNumber', undefined);
      }
      if (result.version !== asset.version) {
        await audit(tx, context, 'asset.updated', 'asset', asset.id, {
          fields: Object.keys(details),
        });
      }
      return assetDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

export const relocateAssetRoute = defineRoute({
  method: 'post',
  path: '/v1/assets/:assetId/relocate',
  operationId: 'relocateAsset',
  summary: 'Move an asset to another site',
  description:
    'To any site of the company, the same customer’s or another’s; a `relocated` event keeps where it was. 422 `same_site` when it is already there.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    siteId: z.uuid(),
    locationNote: optionalText(500),
    note: optionalText(1000),
  }),
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset or site.' },
    409: { description: 'Changed elsewhere.' },
    422: { description: 'Already at that site.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const asset = await readableAsset(tx, principal, params.assetId);
      const site = await tx.sites.find(body.siteId);
      if (site === undefined) {
        throw notFound('This site does not exist.');
      }
      const result = await tx.assets.relocate(
        asset.id,
        body.expectedVersion,
        {
          customerId: site.customerId,
          siteId: site.id,
          ...(body.locationNote === undefined ? {} : { locationNote: body.locationNote }),
        },
        principal.userId,
        { note: body.note },
      );
      if (result === 'version_conflict') {
        throw conflict('version_conflict', 'This asset was changed by someone else. Reload it.');
      }
      if (result === 'same_site') {
        throw unprocessable('same_site', 'The asset is already at this site.', [
          { field: 'body.siteId', code: 'same_site', message: 'Choose another site.' },
        ]);
      }
      await audit(tx, context, 'asset.relocated', 'asset', asset.id, {
        fromSiteId: asset.siteId,
        toSiteId: site.id,
      });
      return assetDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

export const assetStatusRoute = defineRoute({
  method: 'post',
  path: '/v1/assets/:assetId/status',
  operationId: 'setAssetStatus',
  summary: 'Put an asset out of service, retire it, or bring it back',
  description:
    'A `status_changed` event keeps what it was. 422 `same_status` when nothing changes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    status: assetStatusSchema,
    note: optionalText(1000),
  }),
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset.' },
    409: { description: 'Changed elsewhere.' },
    422: { description: 'Already in that status.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const asset = await readableAsset(tx, principal, params.assetId);
      const result = await tx.assets.setStatus(
        asset.id,
        body.expectedVersion,
        body.status,
        principal.userId,
        {
          note: body.note,
        },
      );
      if (result === 'version_conflict') {
        throw conflict('version_conflict', 'This asset was changed by someone else. Reload it.');
      }
      if (result === 'same_status') {
        throw unprocessable('same_status', 'The asset already has this status.', [
          { field: 'body.status', code: 'same_status', message: 'Choose another status.' },
        ]);
      }
      await audit(tx, context, 'asset.status_changed', 'asset', asset.id, {
        from: asset.status,
        to: body.status,
      });
      return assetDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

export const assetConditionRoute = defineRoute({
  method: 'post',
  path: '/v1/assets/:assetId/condition',
  operationId: 'recordAssetCondition',
  summary: 'Record what state an asset is in',
  description:
    'Engineers on a job at its site, and the office. Optionally on a job (`workOrderId`), which an engineer must be working. A retired asset takes no condition (409 `asset_retired`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.record',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: z.object({
    condition: assetConditionSchema,
    note: optionalText(1000),
    workOrderId: z.uuid().optional(),
  }),
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset or job.' },
    409: { description: 'The asset is retired.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const asset = await readableAsset(tx, principal, params.assetId);
      if (asset.status === 'retired') {
        throw conflict('asset_retired', 'A retired asset takes no condition.');
      }
      if (body.workOrderId !== undefined) {
        const job = await readableWorkOrder(tx, principal, body.workOrderId);
        if (!holds(principal, 'asset.manage') && !(await mayWork(tx, principal, job))) {
          throw notFound('This work order does not exist.');
        }
      }
      const result = await tx.assets.recordCondition(asset.id, body.condition, principal.userId, {
        note: body.note,
        workOrderId: body.workOrderId,
      });
      if (result === undefined) {
        throw notFound('This asset does not exist.');
      }
      await audit(tx, context, 'asset.condition_recorded', 'asset', asset.id, {
        condition: body.condition,
      });
      return assetDetail(tx, context, result.asset);
    });
    return { status: 200, body: detail };
  },
});

export const reissueTagRoute = defineRoute({
  method: 'post',
  path: '/v1/assets/:assetId/tag',
  operationId: 'reissueAssetTag',
  summary: 'Issue a new tag',
  description:
    'For a lost or damaged label: a new code, and the old tag opens nothing from now on.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: assetParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The asset.', schema: assetDetailSchema },
    404: { description: 'No such asset.' },
    409: { description: 'Changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const asset = await readableAsset(tx, principal, params.assetId);
      const result = await tx.assets.reissueTag(
        asset.id,
        body.expectedVersion,
        await freshTagCode(tx),
        principal.userId,
      );
      if (result === 'version_conflict') {
        throw conflict('version_conflict', 'This asset was changed by someone else. Reload it.');
      }
      await audit(tx, context, 'asset.tag_reissued', 'asset', asset.id);
      return assetDetail(tx, context, result);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Routes: jobs
// ---------------------------------------------------------------------------

const jobParams = z.object({ workOrderId: z.uuid() });

export const jobAssetsRoute = defineRoute({
  method: 'get',
  path: '/v1/work-orders/:workOrderId/assets',
  operationId: 'listWorkOrderAssets',
  summary: 'The assets a job is for',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: jobParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The assets, first linked first, and those at the site that are not linked.',
      schema: z.object({
        items: z.array(assetSummarySchema),
        /** The site's other assets that are not retired, for linking. */
        atSite: z.array(assetSummarySchema),
        can: z.object({ link: z.boolean(), unlink: z.boolean(), register: z.boolean() }),
      }),
    },
    404: { description: 'No such job.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      const links = await tx.assets.linksOfWorkOrders([job.id]);
      const linked = new Set(links.map((link) => link.assetId));
      const [assets, site] = await Promise.all([
        tx.assets.findMany([...linked]),
        tx.assets.list({ siteId: job.siteId, statuses: ['active', 'out_of_service'], limit: 200 }),
      ]);
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      const works = holds(principal, 'asset.manage') || (await mayWork(tx, principal, job));
      const records = holds(principal, 'asset.record') && works;
      return {
        items: await assetSummaries(
          tx,
          links.flatMap((link) => {
            const asset = byId.get(link.assetId);
            return asset === undefined ? [] : [asset];
          }),
          context.config.WEB_APP_URL,
        ),
        atSite: await assetSummaries(
          tx,
          site.items.filter((asset) => !linked.has(asset.id)),
          context.config.WEB_APP_URL,
        ),
        can: { link: records, unlink: holds(principal, 'asset.manage'), register: records },
      };
    });
    return { status: 200, body };
  },
});

export const linkJobAssetRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/assets',
  operationId: 'linkWorkOrderAsset',
  summary: 'Say a job is for an asset',
  description:
    'One of the job’s site’s assets (422 `asset_not_at_site`), not retired (409 `asset_retired`). Engineers link only on jobs they are working. Linking twice is harmless.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.record',
  feature: ASSETS,
  params: jobParams,
  query: noSchema,
  body: z.object({ assetId: z.uuid() }),
  responses: {
    204: { description: 'Linked.' },
    404: { description: 'No such job or asset.' },
    409: { description: 'The asset is retired.' },
    422: { description: 'Not at the job’s site.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      if (!holds(principal, 'asset.manage') && !(await mayWork(tx, principal, job))) {
        throw notFound('This work order does not exist.');
      }
      const asset = await tx.assets.find(body.assetId);
      if (asset === undefined) {
        throw notFound('This asset does not exist.');
      }
      if (asset.siteId !== job.siteId) {
        throw unprocessable('asset_not_at_site', 'This asset is at another site.', [
          {
            field: 'body.assetId',
            code: 'asset_not_at_site',
            message: 'Link one of the job’s site’s assets.',
          },
        ]);
      }
      if (asset.status === 'retired') {
        throw conflict('asset_retired', 'A retired asset is not linked to new work.');
      }
      if (await tx.assets.link(job.id, asset.id, principal.userId)) {
        await audit(tx, context, 'asset.linked', 'asset', asset.id, { workOrderId: job.id });
      }
    });
    return { status: 204, body: undefined };
  },
});

export const unlinkJobAssetRoute = defineRoute({
  method: 'delete',
  path: '/v1/work-orders/:workOrderId/assets/:assetId',
  operationId: 'unlinkWorkOrderAsset',
  summary: 'Take an asset off a job',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: jobParams.extend({ assetId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Unlinked.' },
    404: { description: 'Not linked.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      if (!(await tx.assets.unlink(job.id, params.assetId))) {
        throw notFound('This asset is not on this job.');
      }
      await audit(tx, context, 'asset.unlinked', 'asset', params.assetId, { workOrderId: job.id });
    });
    return { status: 204, body: undefined };
  },
});

// ---------------------------------------------------------------------------
// Routes: settings
// ---------------------------------------------------------------------------

export const assetSettingsRoute = defineRoute({
  method: 'get',
  path: '/v1/assets/settings',
  operationId: 'getAssetSettings',
  summary: 'How far ahead warranties are flagged',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The settings.', schema: settingsSchema } },
  handler: async (_request, context) => {
    const { principal } = context;
    const settings = await withTenant(principal.tenantId, (tx) => tx.assets.settings());
    return {
      status: 200,
      body: { ...settings, can: { edit: holds(principal, 'asset.manage') } },
    };
  },
});

export const saveAssetSettingsRoute = defineRoute({
  method: 'put',
  path: '/v1/assets/settings',
  operationId: 'saveAssetSettings',
  summary: 'Set how far ahead warranties are flagged',
  description: '`expectedVersion` 0 the first time; 409 `version_conflict` when changed elsewhere.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: noSchema,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(0),
    warrantyAlertDays: warrantyAlertDaysSchema,
  }),
  responses: {
    200: { description: 'The settings.', schema: settingsSchema },
    409: { description: 'Changed elsewhere.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.assets.saveSettings(
        body.expectedVersion,
        body.warrantyAlertDays,
        principal.userId,
      );
      if (result === 'version_conflict') {
        throw new ApiError(
          409,
          'version_conflict',
          'The settings were changed by someone else. Reload them.',
        );
      }
      await audit(tx, context, 'asset_settings.updated', 'asset_settings', principal.tenantId, {
        warrantyAlertDays: body.warrantyAlertDays,
      });
      return result;
    });
    return { status: 200, body: { ...saved, can: { edit: true } } };
  },
});

export const assetRoutes = [
  // Literal paths before `:assetId`.
  assetSettingsRoute,
  saveAssetSettingsRoute,
  assetByTagRoute,
  listAssetsRoute,
  createAssetRoute,
  getAssetRoute,
  assetTimelineRoute,
  updateAssetRoute,
  relocateAssetRoute,
  assetStatusRoute,
  assetConditionRoute,
  reissueTagRoute,
  jobAssetsRoute,
  linkJobAssetRoute,
  unlinkJobAssetRoute,
];
