import {
  can,
  findTransition,
  formatWorkOrderReference,
  type Principal,
  type WorkOrderState,
} from '@integr8/core';
import type {
  Attachment,
  Customer,
  CustomerContact,
  FileRecord,
  Site,
  TenantTransaction,
  WorkOrder,
} from '@integr8/db';
import { z } from 'zod';
import { forbidden, notFound } from '../../http/errors.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Contract shapes and access rules shared by the customer, site, job type and
 * work order routes (P10).
 */

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** A query parameter that may be repeated: `?state=a&state=b`. Always an array after parsing. */
export function many<T extends z.ZodType>(schema: T, max = 20) {
  return z
    .union([schema, z.array(schema).max(max)])
    .optional()
    .transform((value) => (value === undefined ? [] : ([value].flat() as z.infer<T>[])));
}

export const booleanQuery = z.enum(['true', 'false']).optional();

/** Opaque cursors for alphabetical lists. */
export function encodeNameCursor(next: { name: string; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

export function decodeNameCursor(
  cursor: string | undefined,
): { name: string; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const result = z.object({ name: z.string(), id: z.uuid() }).safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullable().optional();

export const personSchema = z.object({ id: z.uuid(), name: z.string() });

export const addressSchema = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postcode: z.string().nullable(),
  countryCode: z.string().nullable(),
});

export const addressInputSchema = z.object({
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(120),
  region: optionalText(120),
  postcode: optionalText(20),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/u, 'A two-letter country code')
    .nullable()
    .optional(),
});

export const customerStatusSchema = z.enum(['active', 'on_hold', 'closed']);

export const customerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  accountNumber: z.string().nullable(),
  status: customerStatusSchema,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: addressSchema,
  tags: z.array(z.string()),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const customerInputSchema = z.object({
  name: text(200).min(1),
  accountNumber: optionalText(64),
  status: customerStatusSchema.optional(),
  email: z
    .email()
    .max(254)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optionalText(40),
  address: addressInputSchema.optional(),
  tags: z.array(text(40)).max(50).optional(),
  notes: optionalText(10_000),
});

export const contactSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isPrimary: z.boolean(),
  notes: z.string().nullable(),
  archived: z.boolean(),
});

export const contactInputSchema = z.object({
  name: text(200).min(1),
  jobTitle: optionalText(120),
  email: z
    .email()
    .max(254)
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  phone: optionalText(40),
  isPrimary: z.boolean().optional(),
  notes: optionalText(4000),
});

export const accessSchema = z.object({
  gateCode: z.string().nullable(),
  parking: z.string().nullable(),
  askFor: z.string().nullable(),
  hazards: z.string().nullable(),
  notes: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: personSchema.nullable(),
});

export const accessInputSchema = z.object({
  gateCode: optionalText(200),
  parking: optionalText(2000),
  askFor: optionalText(500),
  hazards: optionalText(4000),
  notes: optionalText(4000),
});

export const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export const siteSchema = z.object({
  id: z.uuid(),
  customerId: z.uuid(),
  name: z.string(),
  address: addressSchema.extend({ line1: z.string() }),
  location: locationSchema.nullable(),
  geocodeStatus: z.enum(['pending', 'found', 'not_found', 'failed', 'manual']),
  geocodeAccuracy: z.string().nullable(),
  contactId: z.uuid().nullable(),
  access: accessSchema,
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const attachmentSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  title: z.string(),
  kind: z.enum(['site_plan', 'manual', 'report', 'photo', 'other']),
  /** For a job photo: taken before the work started, or after it was done (P14). */
  stage: z.enum(['before', 'after']).nullable(),
  contentType: z.string(),
  byteSize: z.number().int(),
  addedBy: personSchema,
  createdAt: z.string(),
});

export const workOrderStateSchema = z.enum([
  'scheduled',
  'dispatched',
  'travelling',
  'on_site',
  'in_progress',
  'awaiting_parts',
  'complete',
  'reviewed',
  'cancelled',
]);

export const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const workOrderSummarySchema = z.object({
  id: z.uuid(),
  reference: z.number().int(),
  referenceLabel: z.string(),
  title: z.string(),
  state: workOrderStateSchema,
  priority: prioritySchema,
  dueFrom: z.string().nullable(),
  dueBy: z.string().nullable(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string(), city: z.string().nullable() }),
  jobType: z.object({ id: z.uuid(), name: z.string(), code: z.string() }),
  crew: z.array(personSchema.extend({ lead: z.boolean() })),
  revision: z.number().int(),
  stateChangedAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export type People = Map<string, string>;

export async function peopleOf(tx: TenantTransaction): Promise<People> {
  const members = await tx.tenantUsers.list({ includeDeleted: true });
  return new Map(members.map((member) => [member.userId, member.displayName]));
}

export const personBody = (id: string, people: People) => ({ id, name: people.get(id) ?? '' });

export function customerBody(customer: Customer) {
  return {
    id: customer.id,
    name: customer.name,
    accountNumber: customer.accountNumber,
    status: customer.status,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    tags: customer.tags,
    notes: customer.notes,
    createdAt: iso(customer.createdAt),
    updatedAt: iso(customer.updatedAt),
  };
}

export function contactBody(contact: CustomerContact) {
  return {
    id: contact.id,
    name: contact.name,
    jobTitle: contact.jobTitle,
    email: contact.email,
    phone: contact.phone,
    isPrimary: contact.isPrimary,
    notes: contact.notes,
    archived: contact.archivedAt !== null,
  };
}

export function siteBody(site: Site, people: People) {
  return {
    id: site.id,
    customerId: site.customerId,
    name: site.name,
    address: site.address,
    location: site.location,
    geocodeStatus: site.geocodeStatus,
    geocodeAccuracy: site.geocodeAccuracy,
    contactId: site.contactId,
    access: {
      gateCode: site.access.gateCode,
      parking: site.access.parking,
      askFor: site.access.askFor,
      hazards: site.access.hazards,
      notes: site.access.notes,
      updatedAt: isoOrNull(site.access.updatedAt),
      updatedBy: site.access.updatedBy === null ? null : personBody(site.access.updatedBy, people),
    },
    archived: site.archivedAt !== null,
    createdAt: iso(site.createdAt),
    updatedAt: iso(site.updatedAt),
  };
}

export async function attachmentBodies(
  tx: TenantTransaction,
  attachments: Attachment[],
  people: People,
) {
  const files = new Map<string, FileRecord>(
    (await tx.files.findMany(attachments.map((attachment) => attachment.fileId))).map((file) => [
      file.id,
      file,
    ]),
  );
  return attachments.flatMap((attachment) => {
    const file = files.get(attachment.fileId);
    if (file?.deletedAt !== null) {
      return [];
    }
    return [
      {
        id: attachment.id,
        fileId: attachment.fileId,
        title: attachment.title,
        kind: attachment.kind,
        stage: attachment.stage,
        contentType: file.contentType,
        byteSize: file.byteSize,
        addedBy: personBody(attachment.addedBy, people),
        createdAt: iso(attachment.createdAt),
      },
    ];
  });
}

/** Summaries for a list of jobs, with the names a list shows, in few queries. */
export async function workOrderSummaries(
  tx: TenantTransaction,
  workOrders: WorkOrder[],
  people?: People,
) {
  const [customers, sites, jobTypes, crews, known] = await Promise.all([
    tx.customers.findMany(workOrders.map((job) => job.customerId)),
    tx.sites.findMany(workOrders.map((job) => job.siteId)),
    tx.jobTypes.list({ includeArchived: true }),
    tx.workOrders.listCrews(workOrders.map((job) => job.id)),
    people === undefined ? peopleOf(tx) : Promise.resolve(people),
  ]);
  const customerById = new Map(customers.map((customer) => [customer.id, customer]));
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const typeById = new Map(jobTypes.map((type) => [type.id, type]));
  return workOrders.map((job) => {
    const customer = customerById.get(job.customerId);
    const site = siteById.get(job.siteId);
    const type = typeById.get(job.jobTypeId);
    return {
      id: job.id,
      reference: job.reference,
      referenceLabel: formatWorkOrderReference(job.reference),
      title: job.title,
      state: job.state,
      priority: job.priority,
      dueFrom: isoOrNull(job.dueFrom),
      dueBy: isoOrNull(job.dueBy),
      customer: { id: job.customerId, name: customer?.name ?? '' },
      site: { id: job.siteId, name: site?.name ?? '', city: site?.address.city ?? null },
      jobType: { id: job.jobTypeId, name: type?.name ?? '', code: type?.code ?? '' },
      crew: (crews.get(job.id) ?? []).map((member) => ({
        ...personBody(member.userId, known),
        lead: member.lead,
      })),
      revision: job.revision,
      stateChangedAt: iso(job.stateChangedAt),
      createdAt: iso(job.createdAt),
      updatedAt: iso(job.updatedAt),
    };
  });
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * The job, if this person may see it: anyone with `work_order.read_all`, or
 * someone on its crew. Anyone else is told it does not exist.
 */
export async function readableWorkOrder(
  tx: TenantTransaction,
  principal: Principal,
  workOrderId: string,
): Promise<WorkOrder> {
  const job = await tx.workOrders.find(workOrderId);
  if (job === undefined) {
    throw notFound('This work order does not exist.');
  }
  if (
    can(principal.role, 'work_order.read_all') ||
    (await tx.workOrders.isAssigned(job.id, principal.userId))
  ) {
    return job;
  }
  throw notFound('This work order does not exist.');
}

/**
 * Whether this person may work the job: an engineer on its crew, or the office.
 * What `work_order.progress` means for a particular job.
 */
export async function mayWork(
  tx: TenantTransaction,
  principal: Principal,
  job: WorkOrder,
): Promise<boolean> {
  if (!can(principal.role, 'work_order.progress')) {
    return false;
  }
  return (
    can(principal.role, 'work_order.manage') || tx.workOrders.isAssigned(job.id, principal.userId)
  );
}

export async function requireWork(
  tx: TenantTransaction,
  principal: Principal,
  job: WorkOrder,
): Promise<void> {
  if (!(await mayWork(tx, principal, job))) {
    throw forbidden('Only the crew on this job, or the office, can do that.');
  }
}

/** The transitions this person may make from a job's current state. */
export async function allowedTransitions(
  tx: TenantTransaction,
  principal: Principal,
  job: WorkOrder,
) {
  const working = await mayWork(tx, principal, job);
  const next: { to: WorkOrderState; requiresReason: boolean }[] = [];
  for (const to of workOrderStateSchema.options) {
    const transition = findTransition(job.state, to);
    if (transition === undefined) {
      continue;
    }
    const allowed =
      transition.permission === 'work_order.progress'
        ? working
        : can(principal.role, transition.permission);
    if (allowed) {
      next.push({ to, requiresReason: transition.requiresReason });
    }
  }
  return next;
}
