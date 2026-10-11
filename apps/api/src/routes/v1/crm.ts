import {
  currencyCodeSchema,
  decimalAmountSchema,
  holds,
  LEAD_MATCH_REASONS,
  leadConvertible,
  leadSourceSchema,
  leadStatusSchema,
  leadTransitionAllowed,
  OPEN_LEAD_STATUSES,
} from '@integr8/core';
import { type Lead, type LeadInput, normaliseEmail, phoneDigits, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { activityBodies, activitySchema } from './crm-activities.js';
import { createOpportunity, opportunityBodies, opportunitySchema } from './crm-opportunities.js';
import { duplicateAccountNumber, stripUndefined } from './customers.js';
import {
  booleanQuery,
  contactInputSchema,
  customerBody,
  customerInputSchema,
  customerSchema,
  many,
} from './operations.js';
import {
  alreadyConverted,
  crmAudit,
  decodeDateCursor,
  encodeDateCursor,
  FEATURE,
  requireAssignableMember,
  TAGS,
  versionConflict,
} from './crm-shared.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The CRM (CRM/ERP plan): leads in phase C1, converting them into customers
 * and the CRM summary on a customer in phase C2; opportunities on conversion
 * and in that summary in phase C3 (`crm-opportunities.ts`, `crm-activities.ts`).
 *
 * Every route here needs the company's `crm` module as well as the seat's
 * permission (`feature: 'crm'`); see `http/features.ts`. Leads are archived,
 * never deleted, and edited with optimistic concurrency: an edit names the
 * version it read and loses, with 409 `version_conflict`, to a newer one.
 */

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export const leadSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  companyName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  source: leadSourceSchema,
  status: leadStatusSchema,
  assignedTo: z.uuid().nullable(),
  /** A decimal string, such as `1250.5`. Never a JSON number, so nothing rounds it. */
  estimatedValue: z.string().nullable(),
  currencyCode: z.string().nullable(),
  notes: z.string().nullable(),
  unqualifiedReason: z.string().nullable(),
  convertedCustomerId: z.uuid().nullable(),
  convertedContactId: z.uuid().nullable(),
  convertedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export function leadBody(lead: Lead): z.infer<typeof leadSchema> {
  return {
    id: lead.id,
    displayName: lead.displayName,
    companyName: lead.companyName,
    email: lead.email,
    phone: lead.phone,
    source: lead.source,
    status: lead.status,
    assignedTo: lead.assignedTo,
    estimatedValue: lead.estimatedValue,
    currencyCode: lead.currencyCode,
    notes: lead.notes,
    unqualifiedReason: lead.unqualifiedReason,
    convertedCustomerId: lead.convertedCustomerId,
    convertedContactId: lead.convertedContactId,
    convertedAt: isoOrNull(lead.convertedAt),
    version: lead.version,
    createdBy: lead.createdBy,
    createdAt: iso(lead.createdAt),
    updatedAt: iso(lead.updatedAt),
    archivedAt: isoOrNull(lead.archivedAt),
  };
}

const leadFields = {
  displayName: z.string().trim().min(1).max(200),
  companyName: z.string().trim().max(200).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  source: leadSourceSchema.optional(),
  /** Any status but `converted`, which only converting a lead reaches. */
  status: z.enum(OPEN_LEAD_STATUSES).optional(),
  assignedTo: z.uuid().nullable().optional(),
  estimatedValue: decimalAmountSchema.nullable().optional(),
  /** Defaults to the company's currency when a value is given without one. */
  currencyCode: currencyCodeSchema.nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  unqualifiedReason: z.string().trim().max(1000).nullable().optional(),
};

const createLeadSchema = z.object(leadFields);

const updateLeadSchema = z
  .object({
    ...leadFields,
    displayName: leadFields.displayName.optional(),
    /** The `version` of the lead as it was read. */
    expectedVersion: z.number().int().positive(),
    /** Archive (`true`) or restore (`false`). */
    archived: z.boolean().optional(),
  })
  .strict();

/** What may still change on a converted lead: it is history, but annotatable and filable. */
const CONVERTED_EDITABLE = new Set(['notes', 'assignedTo', 'archived', 'expectedVersion']);

/** The lead fields a body carries, without the ones it left out. */
function toLeadInput(body: Readonly<Record<string, unknown>>): Partial<LeadInput> {
  const input: Partial<LeadInput> = {};
  for (const key of Object.keys(leadFields) as (keyof typeof leadFields)[]) {
    const value = body[key];
    if (value !== undefined) {
      (input as Record<string, unknown>)[key] = value;
    }
  }
  return input;
}

const leadParams = z.object({ leadId: z.uuid() });

export const listLeadsRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads',
  operationId: 'listLeads',
  summary: 'Find leads',
  description:
    'Newest first, a page at a time. `q` matches words or their beginnings in the name, company, email or phone. Archived leads are left out unless `includeArchived=true`. `assignedTo` is a member id, `me`, or `none`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(leadStatusSchema, 5),
    source: many(leadSourceSchema, 5),
    assignedTo: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
    includeArchived: booleanQuery,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of leads.',
      schema: z.object({ items: z.array(leadSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const assignedTo =
      query.assignedTo === undefined
        ? undefined
        : query.assignedTo === 'me'
          ? context.principal.userId
          : query.assignedTo === 'none'
            ? null
            : query.assignedTo;
    const page = await withTenant(context.principal.tenantId, (tx) =>
      tx.crmLeads.list({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        sources: query.source,
        ...(assignedTo === undefined ? {} : { assignedTo }),
        includeArchived: query.includeArchived === 'true',
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      }),
    );
    return {
      status: 200,
      body: { items: page.items.map(leadBody), nextCursor: encodeDateCursor(page.next) },
    };
  },
});

export const createLeadRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/leads',
  operationId: 'createLead',
  summary: 'Add a lead',
  description:
    'Saving a lead never creates a customer; converting it does. A value given without a currency is in the company’s currency. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: createLeadSchema,
  responses: {
    201: { description: 'The lead.', schema: leadSchema },
    422: {
      description: 'Invalid, or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ body }, context) => {
    const lead = await withTenant(context.principal.tenantId, async (tx) => {
      if (body.assignedTo !== undefined && body.assignedTo !== null) {
        await requireAssignableMember(tx, body.assignedTo);
      }
      const input = toLeadInput(body);
      if (
        input.estimatedValue !== undefined &&
        input.estimatedValue !== null &&
        !input.currencyCode
      ) {
        input.currencyCode = (await tx.settings.get()).currency;
      }
      const created = await tx.crmLeads.create(
        { ...input, displayName: body.displayName },
        context.principal.userId,
      );
      await crmAudit(tx, context, 'crm_lead.created', 'crm_lead', created.id, {
        displayName: created.displayName,
        source: created.source,
        status: created.status,
      });
      return created;
    });
    return { status: 201, body: leadBody(lead) };
  },
});

export const leadDetailSchema = z.object({
  lead: leadSchema,
  can: z.object({
    edit: z.boolean(),
    convert: z.boolean(),
  }),
});

export const getLeadRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads/:leadId',
  operationId: 'getLead',
  summary: 'A lead',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: leadParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The lead, and what this seat may do with it.', schema: leadDetailSchema },
    404: { description: 'No such lead.' },
  },
  handler: async ({ params }, context) => {
    const lead = await withTenant(context.principal.tenantId, (tx) =>
      tx.crmLeads.find(params.leadId),
    );
    if (lead === undefined) {
      throw notFound('This lead does not exist.');
    }
    const { principal } = context;
    return {
      status: 200,
      body: {
        lead: leadBody(lead),
        can: {
          edit: holds(principal, 'crm.lead.manage'),
          convert: holds(principal, 'crm.lead.convert') && leadConvertible(lead),
        },
      },
    };
  },
});

export const updateLeadRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/leads/:leadId',
  operationId: 'updateLead',
  summary: 'Change, assign, qualify or archive a lead',
  description:
    'Send `expectedVersion` as read; a newer version wins and this one is refused with 409 `version_conflict`. A converted lead keeps its details: only notes, the assignee and archiving can change (409 `lead_already_converted` otherwise).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.manage',
  feature: FEATURE,
  params: leadParams,
  query: noSchema,
  body: updateLeadSchema,
  responses: {
    200: { description: 'The lead as it is now.', schema: leadSchema },
    404: { description: 'No such lead.' },
    409: {
      description:
        'Changed by somebody else since it was read (`version_conflict`), or converted (`lead_already_converted`).',
    },
    422: {
      description:
        'Invalid, an impossible status change (`invalid_transition`), or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const lead = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.crmLeads.find(params.leadId);
      if (current === undefined) {
        throw notFound('This lead does not exist.');
      }

      const sent = Object.keys(body).filter(
        (key) => (body as Record<string, unknown>)[key] !== undefined,
      );
      if (current.status === 'converted' && sent.some((key) => !CONVERTED_EDITABLE.has(key))) {
        throw conflict(
          'lead_already_converted',
          'This lead has been converted. Its details now live on the customer; only notes, the assignee and archiving can change here.',
        );
      }
      if (body.status !== undefined && !leadTransitionAllowed(current.status, body.status)) {
        throw unprocessable(
          'invalid_transition',
          `A lead cannot move from ${current.status} to ${body.status}.`,
        );
      }
      if (body.assignedTo !== undefined && body.assignedTo !== null) {
        await requireAssignableMember(tx, body.assignedTo);
      }

      const input = toLeadInput(body);
      // A value always has a currency: when the lead would end up with one and
      // not the other, the company's currency fills the gap.
      const value =
        input.estimatedValue === undefined ? current.estimatedValue : input.estimatedValue;
      const currency = input.currencyCode === undefined ? current.currencyCode : input.currencyCode;
      if (value !== null && !currency) {
        input.currencyCode = (await tx.settings.get()).currency;
      }

      const updated = await tx.crmLeads.update(current.id, body.expectedVersion, {
        ...input,
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (updated === 'not_found') {
        throw notFound('This lead does not exist.');
      }
      if (updated === 'version_conflict') {
        throw versionConflict();
      }

      await crmAudit(tx, context, 'crm_lead.updated', 'crm_lead', updated.id, {
        fields: sent.filter((key) => key !== 'expectedVersion'),
        version: updated.version,
      });
      if (updated.status !== current.status) {
        await crmAudit(tx, context, 'crm_lead.status_changed', 'crm_lead', updated.id, {
          from: current.status,
          to: updated.status,
        });
      }
      if ((current.archivedAt === null) !== (updated.archivedAt === null)) {
        await crmAudit(
          tx,
          context,
          updated.archivedAt === null ? 'crm_lead.restored' : 'crm_lead.archived',
          'crm_lead',
          updated.id,
        );
      }
      return updated;
    });
    return { status: 200, body: leadBody(lead) };
  },
});

// ---------------------------------------------------------------------------
// Conversion (phase C2)
// ---------------------------------------------------------------------------

const leadMatchSchema = z.object({
  customer: customerSchema,
  /** Why it was suggested: the same email or phone (on the customer or a contact), or the same name. */
  reasons: z.array(z.enum(LEAD_MATCH_REASONS)),
});

export const leadMatchesRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads/:leadId/matches',
  operationId: 'listLeadCustomerMatches',
  summary: 'Existing customers that look like a lead',
  description:
    'Suggestions for the conversion screen, by email, phone or name. Nothing is merged: the person converting chooses.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.convert',
  feature: FEATURE,
  params: leadParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'At most ten customers, alphabetical.',
      schema: z.object({ items: z.array(leadMatchSchema) }),
    },
    404: { description: 'No such lead.' },
  },
  handler: async ({ params }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const lead = await tx.crmLeads.find(params.leadId);
      if (lead === undefined) {
        throw notFound('This lead does not exist.');
      }
      const matches = await tx.crmLeads.customerMatches(lead);
      const customers = new Map(
        (await tx.customers.findMany(matches.map((match) => match.customerId))).map((customer) => [
          customer.id,
          customer,
        ]),
      );
      return matches.flatMap((match) => {
        const customer = customers.get(match.customerId);
        return customer === undefined
          ? []
          : [{ customer: customerBody(customer), reasons: match.reasons }];
      });
    });
    return { status: 200, body: { items } };
  },
});

const convertLeadSchema = z
  .object({
    /** The `version` of the lead as it was read. */
    expectedVersion: z.number().int().positive(),
    customer: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('existing'), customerId: z.uuid() }),
      customerInputSchema
        .pick({ name: true, accountNumber: true, email: true, phone: true })
        .extend({ mode: z.literal('new') }),
    ]),
    /** Who to keep as the customer's contact. Defaults to nobody. */
    contact: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('none') }),
        z.object({ mode: z.literal('existing'), contactId: z.uuid() }),
        contactInputSchema
          .pick({ name: true, jobTitle: true, email: true, phone: true, isPrimary: true })
          .extend({ mode: z.literal('new') }),
      ])
      .optional(),
    /**
     * An opportunity to open for the customer at the same time, at the first
     * stage of the default pipeline. Needs `crm.opportunity.manage`.
     */
    opportunity: z
      .object({
        title: z.string().trim().min(1).max(200),
        amount: decimalAmountSchema.nullable().optional(),
        currencyCode: currencyCodeSchema.optional(),
        expectedCloseDate: z.iso.date().nullable().optional(),
      })
      .optional(),
  })
  .strict();

export const leadConversionSchema = z.object({
  lead: leadSchema,
  customerId: z.uuid(),
  contactId: z.uuid().nullable(),
  /** True when converting created the customer, false when it linked an existing one. */
  customerCreated: z.boolean(),
  contactCreated: z.boolean(),
  /** The opportunity opened with the conversion, if one was asked for. */
  opportunityId: z.uuid().nullable(),
});

const customerNotFound = () =>
  new ApiError(404, 'customer_not_found', 'This customer does not exist.', [
    {
      field: 'body.customer.customerId',
      code: 'customer_not_found',
      message: 'This customer does not exist.',
    },
  ]);

export const convertLeadRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/leads/:leadId/convert',
  operationId: 'convertLead',
  summary: 'Convert a lead into an existing or a new customer',
  description:
    'One transaction: links an existing customer or creates exactly one, optionally keeps a contact, and marks the lead converted. Needs `Idempotency-Key`; a lead converts once, so a second conversion is refused with 409 `lead_already_converted` whatever its key.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.convert',
  feature: FEATURE,
  idempotent: 'required',
  params: leadParams,
  query: noSchema,
  body: convertLeadSchema,
  responses: {
    201: { description: 'The converted lead and what it became.', schema: leadConversionSchema },
    404: { description: 'No such lead (`not_found`) or customer (`customer_not_found`).' },
    409: {
      description:
        'Already converted (`lead_already_converted`), changed since it was read (`version_conflict`), or the customer already has this contact (`duplicate_contact`).',
    },
    422: {
      description:
        'Invalid; the lead is ruled out or archived (`lead_not_convertible`); the customer is closed (`customer_closed`); the contact is not the customer’s (`contact_not_found`); or the account number is taken (`account_number_taken`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      // Locked until this transaction ends: a second conversion of the same
      // lead waits here, then finds it converted and creates nothing.
      const lead = await tx.crmLeads.findForUpdate(params.leadId);
      if (lead === undefined) {
        throw notFound('This lead does not exist.');
      }
      if (lead.status === 'converted') {
        throw alreadyConverted();
      }
      if (lead.version !== body.expectedVersion) {
        throw versionConflict();
      }
      if (!leadConvertible(lead)) {
        throw unprocessable(
          'lead_not_convertible',
          lead.archivedAt === null
            ? 'This lead was ruled out. Move it back to an open status before converting it.'
            : 'This lead is archived. Restore it before converting it.',
        );
      }

      // The customer: one that exists, or exactly one new one.
      let customerId: string;
      let customerCreated = false;
      if (body.customer.mode === 'existing') {
        const customer = await tx.customers.find(body.customer.customerId);
        if (customer === undefined) {
          throw customerNotFound();
        }
        if (customer.status === 'closed') {
          throw unprocessable(
            'customer_closed',
            'This customer is closed. Reopen it, or convert the lead into another customer.',
          );
        }
        customerId = customer.id;
      } else {
        if (!holds(principal, 'customer.manage')) {
          throw forbidden('You may not add customers.');
        }
        const { mode: _mode, ...fields } = body.customer;
        const created = await tx.customers
          .create(stripUndefined(fields), principal.userId)
          .catch(duplicateAccountNumber);
        await crmAudit(tx, context, 'customer.created', 'customer', created.id, {
          name: created.name,
          fromLead: lead.id,
        });
        customerId = created.id;
        customerCreated = true;
      }

      // The contact: nobody, one the customer already has, or a new one.
      let contactId: string | null = null;
      let contactCreated = false;
      const contact = body.contact ?? { mode: 'none' as const };
      if (contact.mode === 'existing') {
        const contacts = customerCreated ? [] : await tx.customers.listContacts(customerId);
        if (!contacts.some((candidate) => candidate.id === contact.contactId)) {
          throw unprocessable('contact_not_found', 'This contact is not one of the customer’s.', [
            {
              field: 'body.contact.contactId',
              code: 'contact_not_found',
              message: 'This contact is not one of the customer’s.',
            },
          ]);
        }
        contactId = contact.contactId;
      } else if (contact.mode === 'new') {
        if (!customerCreated) {
          const email = normaliseEmail(contact.email);
          const phone = phoneDigits(contact.phone);
          const duplicate = (await tx.customers.listContacts(customerId)).find(
            (candidate) =>
              (email !== null && normaliseEmail(candidate.email) === email) ||
              (phone !== null && phoneDigits(candidate.phone) === phone),
          );
          if (duplicate !== undefined) {
            throw new ApiError(
              409,
              'duplicate_contact',
              `${duplicate.name} already has this email or phone on this customer. Choose them instead.`,
              [
                {
                  field: 'body.contact',
                  code: 'duplicate_contact',
                  message: 'The customer already has a contact with this email or phone.',
                  params: { contactId: duplicate.id },
                },
              ],
            );
          }
        }
        const { mode: _mode, ...fields } = contact;
        const added = await tx.customers.addContact(customerId, stripUndefined(fields));
        contactId = added.id;
        contactCreated = true;
      }

      // The lead's own opportunities follow it to the customer it became.
      await tx.crmOpportunities.attachCustomerForLead(lead.id, customerId);
      let opportunityId: string | null = null;
      if (body.opportunity !== undefined) {
        if (!holds(principal, 'crm.opportunity.manage')) {
          throw forbidden('You may not add opportunities.');
        }
        const { title, ...fields } = body.opportunity;
        const opened = await createOpportunity(
          tx,
          principal,
          {
            ...stripUndefined(fields),
            title,
            customerId,
            leadId: lead.id,
            ownerId: lead.assignedTo,
          },
          undefined,
        );
        await crmAudit(tx, context, 'crm_opportunity.created', 'crm_opportunity', opened.id, {
          title: opened.title,
          customerId,
          leadId: lead.id,
          fromConversion: true,
        });
        opportunityId = opened.id;
      }

      const converted = await tx.crmLeads.markConverted(lead.id, body.expectedVersion, {
        customerId,
        contactId,
        convertedBy: principal.userId,
      });
      if (converted === 'not_found') {
        throw notFound('This lead does not exist.');
      }
      if (converted === 'already_converted') {
        throw alreadyConverted();
      }
      if (converted === 'version_conflict') {
        throw versionConflict();
      }

      await crmAudit(tx, context, 'crm_lead.converted', 'crm_lead', lead.id, {
        customerId,
        contactId,
        customerCreated,
        contactCreated,
        opportunityId,
        from: lead.status,
      });
      return {
        lead: converted,
        customerId,
        contactId,
        customerCreated,
        contactCreated,
        opportunityId,
      };
    });
    return { status: 201, body: { ...result, lead: leadBody(result.lead) } };
  },
});

// ---------------------------------------------------------------------------
// A customer's CRM summary (phase C2; opportunities and activities join in C3)
// ---------------------------------------------------------------------------

export const customerCrmSchema = z.object({
  /** The leads that became this customer, most recent first. */
  leads: z.array(leadSchema),
  /** Its newest opportunities, open and closed (the first 20; the list filters by customer for more). */
  opportunities: z.array(opportunitySchema),
  /** Its newest activities (the first 20; the list filters by customer for more). */
  activities: z.array(activitySchema),
  can: z.object({ manageOpportunities: z.boolean(), manageActivities: z.boolean() }),
});

export const customerCrmRoute = defineRoute({
  method: 'get',
  path: '/v1/customers/:customerId/crm',
  operationId: 'getCustomerCrm',
  summary: 'What the CRM knows about a customer',
  description:
    'For the CRM section of the customer screen. Needs `crm.read` and the CRM module, unlike the customer itself, so deal data never shows to someone who may only read customers.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: z.object({ customerId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The customer’s CRM summary.', schema: customerCrmSchema },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      if ((await tx.customers.find(params.customerId)) === undefined) {
        throw notFound('This customer does not exist.');
      }
      const timeZone = (await tx.settings.get()).timezone;
      const [leads, opportunities, activities] = await Promise.all([
        tx.crmLeads.convertedInto(params.customerId),
        tx.crmOpportunities.list({ customerId: params.customerId, limit: 20 }),
        tx.crmActivities.list({
          customerId: params.customerId,
          order: 'recent',
          timeZone,
          limit: 20,
        }),
      ]);
      return {
        leads: leads.map(leadBody),
        opportunities: await opportunityBodies(tx, opportunities.items),
        activities: await activityBodies(tx, activities.items),
        can: {
          manageOpportunities: holds(principal, 'crm.opportunity.manage'),
          manageActivities: holds(principal, 'crm.activity.manage'),
        },
      };
    });
    return { status: 200, body };
  },
});

export const crmRoutes = [
  listLeadsRoute,
  createLeadRoute,
  getLeadRoute,
  updateLeadRoute,
  leadMatchesRoute,
  convertLeadRoute,
  customerCrmRoute,
];
