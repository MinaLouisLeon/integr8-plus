import { can, type Principal } from '@integr8/core';
import {
  type AttachmentOwner,
  type Customer,
  type Site,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { GEOCODE_QUEUE } from '../../geo/geocode-site.js';
import {
  accessInputSchema,
  addressInputSchema,
  attachmentBodies,
  attachmentSchema,
  booleanQuery,
  contactBody,
  contactInputSchema,
  contactSchema,
  customerBody,
  customerInputSchema,
  customerSchema,
  customerStatusSchema,
  decodeNameCursor,
  encodeNameCursor,
  locationSchema,
  many,
  peopleOf,
  readableWorkOrder,
  requireWork,
  siteBody,
  siteSchema,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';

/**
 * Customers, their contacts and sites, and files attached to any of them (P10).
 *
 * Everyone in the company may read customers and sites — an engineer needs the
 * access notes for the job in front of them — and dispatchers, admins and owners
 * change them. Nothing here is deleted: customers close, contacts and sites are
 * archived, attachments are removed from the record.
 */

const TAGS = ['customers'];

const customerParams = z.object({ customerId: z.uuid() });
const siteParams = z.object({ siteId: z.uuid() });

async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType,
    resourceId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

/** Refused with a message a person can act on, rather than a constraint name. */
function duplicateAccountNumber(error: unknown): never {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code === '23505' && constraint === 'customers_account_number_unique') {
    throw unprocessable(
      'account_number_taken',
      'Another customer already has this account number.',
      [
        {
          field: 'body.accountNumber',
          code: 'account_number_taken',
          message: 'Another customer already has this account number.',
        },
      ],
    );
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const listCustomersRoute = defineRoute({
  method: 'get',
  path: '/v1/customers',
  operationId: 'listCustomers',
  summary: 'Find customers',
  description:
    'Alphabetical, a page at a time. `q` matches words or their beginnings in the name, account number, email, phone, city or postcode.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(customerStatusSchema, 3),
    tag: many(z.string().trim().max(40), 10),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of customers.',
      schema: z.object({ items: z.array(customerSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeNameCursor(query.cursor);
    const page = await withTenant(context.principal.tenantId, (tx) =>
      tx.customers.list({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        tags: query.tag,
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      }),
    );
    return {
      status: 200,
      body: { items: page.items.map(customerBody), nextCursor: encodeNameCursor(page.next) },
    };
  },
});

export const customerTagsRoute = defineRoute({
  method: 'get',
  path: '/v1/customer-tags',
  operationId: 'listCustomerTags',
  summary: 'Tags in use on customers',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Tags, most used first.',
      schema: z.object({
        items: z.array(z.object({ tag: z.string(), customers: z.number().int() })),
      }),
    },
  },
  handler: async (_input, context) => {
    const items = await withTenant(context.principal.tenantId, (tx) => tx.customers.tagsInUse());
    return { status: 200, body: { items } };
  },
});

export const createCustomerRoute = defineRoute({
  method: 'post',
  path: '/v1/customers',
  operationId: 'createCustomer',
  summary: 'Add a customer',
  description: 'Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: customerInputSchema,
  responses: {
    201: { description: 'The customer.', schema: customerSchema },
    422: { description: 'Invalid, or the account number is taken (`account_number_taken`).' },
  },
  handler: async ({ body }, context) => {
    const customer = await withTenant(context.principal.tenantId, async (tx) => {
      const created = await tx.customers
        .create(
          {
            name: body.name,
            ...(body.accountNumber === undefined ? {} : { accountNumber: body.accountNumber }),
            ...(body.status === undefined ? {} : { status: body.status }),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.phone === undefined ? {} : { phone: body.phone }),
            ...(body.address === undefined ? {} : { address: stripUndefined(body.address) }),
            ...(body.tags === undefined ? {} : { tags: body.tags }),
            ...(body.notes === undefined ? {} : { notes: body.notes }),
          },
          context.principal.userId,
        )
        .catch(duplicateAccountNumber);
      await audit(tx, context, 'customer.created', 'customer', created.id, { name: created.name });
      return created;
    });
    return { status: 201, body: customerBody(customer) };
  },
});

export const customerDetailSchema = z.object({
  customer: customerSchema,
  contacts: z.array(contactSchema),
  sites: z.array(siteSchema),
  attachments: z.array(attachmentSchema),
  recentWorkOrders: z.array(workOrderSummarySchema),
  can: z.object({ edit: z.boolean(), createWorkOrder: z.boolean() }),
});

export const getCustomerRoute = defineRoute({
  method: 'get',
  path: '/v1/customers/:customerId',
  operationId: 'getCustomer',
  summary: 'A customer, with contacts, sites and recent jobs',
  description: 'Recent jobs are those this person may see.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: customerParams,
  query: z.object({ includeArchived: booleanQuery }),
  body: noSchema,
  responses: {
    200: { description: 'The customer.', schema: customerDetailSchema },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params, query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const customer = await tx.customers.find(params.customerId);
      if (customer === undefined) {
        throw notFound('This customer does not exist.');
      }
      return customerDetailBody(tx, principal, customer, query.includeArchived === 'true');
    });
    return { status: 200, body };
  },
});

/** A customer as the detail route and a phone's sync (P12) both show it. */
export async function customerDetailBody(
  tx: TenantTransaction,
  principal: Principal,
  customer: Customer,
  includeArchived = false,
) {
  const [contacts, sites, attachments, jobs, people] = await Promise.all([
    tx.customers.listContacts(customer.id, { includeArchived }),
    tx.sites.list({ customerId: customer.id, includeArchived, limit: 500 }),
    tx.attachments.list({ customerId: customer.id }),
    tx.workOrders.list({
      customerId: customer.id,
      order: 'created',
      limit: 20,
      ...(can(principal.role, 'work_order.read_all') ? {} : { assigneeId: principal.userId }),
    }),
    peopleOf(tx),
  ]);
  return {
    customer: customerBody(customer),
    contacts: contacts.map(contactBody),
    sites: sites.items.map((site) => siteBody(site, people)),
    attachments: await attachmentBodies(tx, attachments, people),
    recentWorkOrders: await workOrderSummaries(tx, jobs.items, people),
    can: {
      edit: can(principal.role, 'customer.manage'),
      createWorkOrder: can(principal.role, 'work_order.manage') && customer.status !== 'closed',
    },
  };
}

export const updateCustomerRoute = defineRoute({
  method: 'patch',
  path: '/v1/customers/:customerId',
  operationId: 'updateCustomer',
  summary: 'Change a customer',
  description:
    'Closing a customer (`status: closed`) stops new work being created for them; existing work is unaffected.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  params: customerParams,
  query: noSchema,
  body: customerInputSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, 'Change at least one thing'),
  responses: {
    200: { description: 'The customer.', schema: customerSchema },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params, body }, context) => {
    const customer = await withTenant(context.principal.tenantId, async (tx) => {
      const before = await tx.customers.find(params.customerId);
      const updated = await tx.customers
        .update(params.customerId, {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.accountNumber === undefined ? {} : { accountNumber: body.accountNumber }),
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.email === undefined ? {} : { email: body.email }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.address === undefined ? {} : { address: stripUndefined(body.address) }),
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
        })
        .catch(duplicateAccountNumber);
      if (updated === undefined) {
        throw notFound('This customer does not exist.');
      }
      if (before?.status !== updated.status) {
        await audit(tx, context, 'customer.status_changed', 'customer', updated.id, {
          from: before?.status,
          to: updated.status,
        });
      }
      return updated;
    });
    return { status: 200, body: customerBody(customer) };
  },
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export const addContactRoute = defineRoute({
  method: 'post',
  path: '/v1/customers/:customerId/contacts',
  operationId: 'addCustomerContact',
  summary: 'Add a contact to a customer',
  description: 'Making a contact primary makes any other contact of the customer not primary.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  idempotent: true,
  params: customerParams,
  query: noSchema,
  body: contactInputSchema,
  responses: {
    201: { description: 'The contact.', schema: contactSchema },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params, body }, context) => {
    const contact = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.customers.find(params.customerId)) === undefined) {
        throw notFound('This customer does not exist.');
      }
      return tx.customers.addContact(params.customerId, stripUndefined(body));
    });
    return { status: 201, body: contactBody(contact) };
  },
});

export const updateContactRoute = defineRoute({
  method: 'patch',
  path: '/v1/customers/:customerId/contacts/:contactId',
  operationId: 'updateCustomerContact',
  summary: 'Change or archive a contact',
  description:
    '`archived: true` archives the contact; it stays on sites that name it until they are changed.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  params: z.object({ customerId: z.uuid(), contactId: z.uuid() }),
  query: noSchema,
  body: contactInputSchema
    .partial()
    .extend({ archived: z.literal(true).optional() })
    .refine((value) => Object.keys(value).length > 0, 'Change at least one thing'),
  responses: {
    200: { description: 'The contact.', schema: contactSchema },
    404: { description: 'No such contact for this customer.' },
  },
  handler: async ({ params, body }, context) => {
    const contact = await withTenant(context.principal.tenantId, async (tx) => {
      const { archived, ...changes } = body;
      if (archived === true) {
        return tx.customers.archiveContact(params.customerId, params.contactId);
      }
      return tx.customers.updateContact(
        params.customerId,
        params.contactId,
        stripUndefined(changes),
      );
    });
    if (contact === undefined) {
      throw notFound('This contact does not exist.');
    }
    return { status: 200, body: contactBody(contact) };
  },
});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const listSitesRoute = defineRoute({
  method: 'get',
  path: '/v1/sites',
  operationId: 'listSites',
  summary: 'Find sites',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: z.object({
    customerId: z.uuid().optional(),
    q: z.string().trim().max(200).optional(),
    includeArchived: booleanQuery,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of sites.',
      schema: z.object({
        items: z.array(siteSchema.extend({ customerName: z.string() })),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeNameCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.sites.list({
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.q === undefined ? {} : { text: query.q }),
        includeArchived: query.includeArchived === 'true',
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      const [people, customers] = await Promise.all([
        peopleOf(tx),
        tx.customers.findMany(page.items.map((site) => site.customerId)),
      ]);
      const names = new Map(customers.map((customer) => [customer.id, customer.name]));
      return {
        items: page.items.map((site) => ({
          ...siteBody(site, people),
          customerName: names.get(site.customerId) ?? '',
        })),
        nextCursor: encodeNameCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

const siteInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: addressInputSchema.extend({ line1: z.string().trim().min(1).max(200) }),
  contactId: z.uuid().nullable().optional(),
  access: accessInputSchema.optional(),
  /** Places the site by hand. `null` clears a pin and geocodes the address again. */
  location: locationSchema.nullable().optional(),
});

export const createSiteRoute = defineRoute({
  method: 'post',
  path: '/v1/customers/:customerId/sites',
  operationId: 'createSite',
  summary: 'Add a site to a customer',
  description:
    'Without a `location`, the address is geocoded in the background; `geocodeStatus` says how that went. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  idempotent: true,
  params: customerParams,
  query: noSchema,
  body: siteInputSchema,
  responses: {
    201: { description: 'The site.', schema: siteSchema },
    404: { description: 'No such customer.' },
    422: { description: 'Invalid, or the contact is not this customer’s.' },
  },
  handler: async ({ params, body }, context) => {
    const site = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.customers.find(params.customerId)) === undefined) {
        throw notFound('This customer does not exist.');
      }
      await requireOwnContact(tx, params.customerId, body.contactId);
      const created = await tx.sites.create(
        params.customerId,
        {
          name: body.name,
          address: stripUndefined(body.address),
          ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
          ...(body.access === undefined ? {} : { access: stripUndefined(body.access) }),
          ...(body.location === undefined ? {} : { location: body.location }),
        },
        context.principal.userId,
      );
      if (created.geocodeStatus === 'pending') {
        await tx.jobs.enqueue({ queue: GEOCODE_QUEUE, payload: { siteId: created.id } });
      }
      return { site: created, people: await peopleOf(tx) };
    });
    return { status: 201, body: siteBody(site.site, site.people) };
  },
});

const siteDetailSchema = z.object({
  site: siteSchema,
  customer: customerSchema,
  contact: contactSchema.nullable(),
  attachments: z.array(attachmentSchema),
  recentWorkOrders: z.array(workOrderSummarySchema),
  can: z.object({ edit: z.boolean(), editAccess: z.boolean() }),
});

export const getSiteRoute = defineRoute({
  method: 'get',
  path: '/v1/sites/:siteId',
  operationId: 'getSite',
  summary: 'A site, its customer, contact, files and recent jobs',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: siteParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The site.', schema: siteDetailSchema },
    404: { description: 'No such site.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const site = await tx.sites.find(params.siteId);
      if (site === undefined) {
        throw notFound('This site does not exist.');
      }
      const [customer, contacts, attachments, jobs, people] = await Promise.all([
        tx.customers.find(site.customerId),
        site.contactId === null ? Promise.resolve([]) : tx.customers.findContacts([site.contactId]),
        tx.attachments.list({ siteId: site.id }),
        tx.workOrders.list({
          siteId: site.id,
          order: 'created',
          limit: 20,
          ...(can(principal.role, 'work_order.read_all') ? {} : { assigneeId: principal.userId }),
        }),
        peopleOf(tx),
      ]);
      return {
        site: siteBody(site, people),
        customer: customerBody(customer!),
        contact: contacts[0] === undefined ? null : contactBody(contacts[0]),
        attachments: await attachmentBodies(tx, attachments, people),
        recentWorkOrders: await workOrderSummaries(tx, jobs.items, people),
        can: {
          edit: can(principal.role, 'customer.manage'),
          editAccess:
            can(principal.role, 'customer.manage') ||
            (can(principal.role, 'work_order.progress') && jobs.items.length > 0),
        },
      };
    });
    return { status: 200, body };
  },
});

export const updateSiteRoute = defineRoute({
  method: 'patch',
  path: '/v1/sites/:siteId',
  operationId: 'updateSite',
  summary: 'Change a site',
  description:
    'A changed address is geocoded again, unless a `location` is given with it. `archived` archives or restores the site.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  params: siteParams,
  query: noSchema,
  body: z
    .object({
      name: z.string().trim().min(1).max(200).optional(),
      address: addressInputSchema
        .extend({ line1: z.string().trim().min(1).max(200).optional() })
        .optional(),
      contactId: z.uuid().nullable().optional(),
      access: accessInputSchema.optional(),
      location: locationSchema.nullable().optional(),
      archived: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Change at least one thing'),
  responses: {
    200: { description: 'The site.', schema: siteSchema },
    404: { description: 'No such site.' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.sites.find(params.siteId);
      if (current === undefined) {
        throw notFound('This site does not exist.');
      }
      await requireOwnContact(tx, current.customerId, body.contactId);
      const { archived, ...changes } = body;
      let site = await tx.sites.update(
        params.siteId,
        {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.address === undefined ? {} : { address: stripUndefined(changes.address) }),
          ...(changes.contactId === undefined ? {} : { contactId: changes.contactId }),
          ...(changes.access === undefined ? {} : { access: stripUndefined(changes.access) }),
          ...(changes.location === undefined ? {} : { location: changes.location }),
        },
        context.principal.userId,
      );
      if (archived !== undefined && site !== undefined) {
        site = await tx.sites.setArchived(site.id, archived);
      }
      if (site?.geocodeStatus === 'pending' && current.geocodeStatus !== 'pending') {
        await tx.jobs.enqueue({ queue: GEOCODE_QUEUE, payload: { siteId: site.id } });
      }
      return { site: site!, people: await peopleOf(tx) };
    });
    return { status: 200, body: siteBody(result.site, result.people) };
  },
});

export const updateSiteAccessRoute = defineRoute({
  method: 'put',
  path: '/v1/sites/:siteId/access',
  operationId: 'updateSiteAccess',
  summary: 'Correct a site’s access notes',
  description:
    'For the engineer who finds the gate code has changed: anyone working a job at the site may correct its access notes, as well as the office. Every change records who made it and when.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: siteParams,
  query: noSchema,
  body: accessInputSchema,
  responses: {
    200: { description: 'The site.', schema: siteSchema },
    403: { description: 'This person is not working a job at the site.' },
    404: { description: 'No such site.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.sites.find(params.siteId);
      if (current === undefined) {
        throw notFound('This site does not exist.');
      }
      const site = await updateAccessNotes(tx, context, current, stripUndefined(body));
      return { site, people: await peopleOf(tx) };
    });
    return { status: 200, body: siteBody(result.site, result.people) };
  },
});

/**
 * Corrects a site's access notes, if this person may: the office, or anyone
 * working a job at the site. Shared with a phone's sync (P12).
 */
export async function updateAccessNotes(
  tx: TenantTransaction,
  context: RequestContext,
  current: Site,
  access: Partial<Record<'gateCode' | 'parking' | 'askFor' | 'hazards' | 'notes', string | null>>,
): Promise<Site> {
  const { principal } = context;
  if (!can(principal.role, 'customer.manage')) {
    const working =
      can(principal.role, 'work_order.progress') &&
      (await tx.workOrders.list({ siteId: current.id, assigneeId: principal.userId, limit: 1 }))
        .items.length > 0;
    if (!working) {
      throw forbidden(
        'Only the office, or someone working a job at this site, can change its access notes.',
      );
    }
  }
  const site = await tx.sites.update(current.id, { access }, principal.userId);
  await audit(tx, context, 'site.access_updated', 'site', current.id, {
    fields: Object.keys(access),
  });
  return site!;
}

async function requireOwnContact(
  tx: TenantTransaction,
  customerId: string,
  contactId: string | null | undefined,
) {
  if (contactId === undefined || contactId === null) {
    return;
  }
  const [contact] = await tx.customers.findContacts([contactId]);
  if (contact?.customerId !== customerId || contact.archivedAt !== null) {
    throw unprocessable(
      'contact_not_customers',
      'The contact must be a current contact of this site’s customer.',
      [
        {
          field: 'body.contactId',
          code: 'contact_not_customers',
          message: 'Choose one of the customer’s contacts.',
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const ownerSchema = z.union([
  z.object({ customerId: z.uuid() }).strict(),
  z.object({ siteId: z.uuid() }).strict(),
  z.object({ workOrderId: z.uuid() }).strict(),
]);

/** Whether this person may add to or remove from what `owner` names. */
async function requireAttachable(
  tx: TenantTransaction,
  context: RequestContext,
  owner: AttachmentOwner,
) {
  const { principal } = context;
  if ('workOrderId' in owner) {
    const job = await readableWorkOrder(tx, principal, owner.workOrderId);
    await requireWork(tx, principal, job);
    return;
  }
  if (!can(principal.role, 'customer.manage')) {
    throw forbidden('Only the office can attach files to customers and sites.');
  }
  const exists =
    'customerId' in owner
      ? (await tx.customers.find(owner.customerId)) !== undefined
      : (await tx.sites.find(owner.siteId)) !== undefined;
  if (!exists) {
    throw notFound('The customer or site does not exist.');
  }
}

export const addAttachmentRoute = defineRoute({
  method: 'post',
  path: '/v1/attachments',
  operationId: 'addAttachment',
  summary: 'Attach an uploaded file to a customer, site or work order',
  description:
    'The file must already be uploaded and confirmed (`/v1/media`). While attached, it cannot be deleted. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    owner: ownerSchema,
    fileId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    kind: z.enum(['site_plan', 'manual', 'report', 'photo', 'other']).optional(),
    /** A job photo taken before or after the work (P14). Only on a work order, as a photo. */
    stage: z.enum(['before', 'after']).optional(),
  }),
  responses: {
    201: { description: 'The attachment.', schema: attachmentSchema },
    403: { description: 'This person may not attach files here.' },
    404: { description: 'No such customer, site, work order or file.' },
  },
  handler: async ({ body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      await requireAttachable(tx, context, body.owner);
      if (
        body.stage !== undefined &&
        (!('workOrderId' in body.owner) || (body.kind ?? 'photo') !== 'photo')
      ) {
        throw unprocessable(
          'stage_not_allowed',
          'Only a photo on a work order is taken before or after.',
          [
            {
              field: 'body.stage',
              code: 'stage_not_allowed',
              message: 'Attach it to a work order, as a photo.',
            },
          ],
        );
      }
      const file = await tx.files.find(body.fileId);
      if (file?.deletedAt !== null) {
        throw notFound('This file does not exist.');
      }
      const attachment = await tx.attachments.add(
        body.owner,
        {
          fileId: file.id,
          title: body.title,
          ...(body.stage === undefined
            ? body.kind === undefined
              ? {}
              : { kind: body.kind }
            : { kind: 'photo' as const, stage: body.stage }),
        },
        context.principal.userId,
      );
      const [shaped] = await attachmentBodies(tx, [attachment], await peopleOf(tx));
      return shaped!;
    });
    return { status: 201, body: result };
  },
});

export const removeAttachmentRoute = defineRoute({
  method: 'delete',
  path: '/v1/attachments/:attachmentId',
  operationId: 'removeAttachment',
  summary: 'Take a file off a customer, site or work order',
  description: 'The file itself stays in storage until it is deleted through `/v1/media`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: z.object({ attachmentId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Removed.' },
    404: { description: 'No such attachment.' },
    409: { description: 'Already removed.' },
  },
  handler: async ({ params }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const attachment = await tx.attachments.find(params.attachmentId);
      if (attachment === undefined) {
        throw notFound('This attachment does not exist.');
      }
      await requireAttachable(tx, context, attachment.owner);
      if (!(await tx.attachments.remove(attachment.id, context.principal.userId))) {
        throw conflict('attachment_removed', 'This attachment was already removed.');
      }
    });
    return { status: 204, body: undefined };
  },
});

/** Drops keys whose value is `undefined`, for repositories typed with exact optional properties. */
export function stripUndefined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

export const customerRoutes = [
  listCustomersRoute,
  customerTagsRoute,
  createCustomerRoute,
  getCustomerRoute,
  updateCustomerRoute,
  addContactRoute,
  updateContactRoute,
  listSitesRoute,
  createSiteRoute,
  getSiteRoute,
  updateSiteRoute,
  updateSiteAccessRoute,
  addAttachmentRoute,
  removeAttachmentRoute,
];
