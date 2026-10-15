import {
  ACTIVITY_KINDS,
  formatWorkOrderReference,
  opportunityEventKind,
  opportunityMoveAllowed,
  WORK_ORDER_PRIORITIES,
} from '@integr8/core';
import { z } from 'zod';
import { unprocessable } from '../../http/errors.js';
import { crmAudit, requireAssignableMember } from '../../routes/v1/crm-shared.js';
import { duplicateAccountNumber } from '../../routes/v1/customers.js';
import { createWorkOrder } from '../../routes/v1/work-orders.js';
import { type ActionPreview, type AnyAiAction, defineAction, previewLabel } from './registry.js';

/**
 * The first four actions (docs/ai §9.1): reversible, low-risk, and already
 * served by domain code the screens use. Nothing here touches money, stock,
 * payroll, deletion, approvals or who may do what.
 */

const name = z.string().trim().min(1).max(200);

// ---------------------------------------------------------------------------
// Create a customer
// ---------------------------------------------------------------------------

const customerPayload = z.object({
  name,
  email: z.string().trim().email().max(320).nullable(),
  phone: z.string().trim().max(50).nullable(),
  city: z.string().trim().max(120).nullable(),
  notes: z.string().trim().max(2000).nullable(),
});

const createCustomer = defineAction({
  key: 'prepare_create_customer',
  description:
    'Prepare adding a new customer by name, with optional email, phone, city and a note. The person confirms before anything is saved.',
  permission: 'customer.manage',
  dataClass: 'company_operational',
  inputSchema: z.object({
    name,
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(50).optional(),
    city: z.string().trim().max(120).optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
  payloadSchema: customerPayload,
  payloadSchemaVersion: 1,
  async prepare(context, input) {
    const payload = customerPayload.parse({
      name: input.name,
      email: input.email === undefined || input.email === '' ? null : input.email,
      phone: input.phone === undefined || input.phone === '' ? null : input.phone,
      city: input.city === undefined || input.city === '' ? null : input.city,
      notes: input.notes === undefined || input.notes === '' ? null : input.notes,
    });
    const existing = await context.tx.customers.list({ text: payload.name, limit: 3 });
    const same = existing.items.filter(
      (customer) => customer.name.trim().toLowerCase() === payload.name.toLowerCase(),
    );
    const l = context.locale;
    const preview: ActionPreview = {
      title: previewLabel(l, `Add customer “${payload.name}”`, `إضافة العميل «${payload.name}»`),
      fields: [
        { label: previewLabel(l, 'Name', 'الاسم'), value: payload.name },
        ...(payload.email === null
          ? []
          : [{ label: previewLabel(l, 'Email', 'البريد'), value: payload.email }]),
        ...(payload.phone === null
          ? []
          : [{ label: previewLabel(l, 'Phone', 'الهاتف'), value: payload.phone }]),
        ...(payload.city === null
          ? []
          : [{ label: previewLabel(l, 'City', 'المدينة'), value: payload.city }]),
      ],
      warnings:
        same.length === 0
          ? []
          : [
              previewLabel(
                l,
                'A customer with this name already exists.',
                'يوجد عميل بهذا الاسم بالفعل.',
              ),
            ],
    };
    return { payload, preview, resourceVersions: {} };
  },
  async execute({ context, tx, proposalId }, payload) {
    const created = await tx.customers
      .create(
        {
          name: payload.name,
          email: payload.email,
          phone: payload.phone,
          address: payload.city === null ? {} : { city: payload.city },
          notes: payload.notes,
        },
        context.principal.userId,
      )
      .catch(duplicateAccountNumber);
    await tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: context.principal.userId,
      actorLabel: context.principal.userId,
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: created.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { name: created.name, source: 'ai_assistant', proposalId },
    });
    return {
      resourceType: 'customer',
      resourceId: created.id,
      summary: `Customer “${created.name}” added.`,
      appRoute: 'customers',
    };
  },
  verify() {
    return Promise.resolve(true);
  },
});

// ---------------------------------------------------------------------------
// Create a work order
// ---------------------------------------------------------------------------

const workOrderPayload = z.object({
  customerId: z.uuid(),
  siteId: z.uuid(),
  jobTypeId: z.uuid(),
  title: name.nullable(),
  description: z.string().trim().max(2000).nullable(),
  priority: z.enum(WORK_ORDER_PRIORITIES).nullable(),
  dueBy: z.iso.datetime().nullable(),
});

const createWorkOrderAction = defineAction({
  key: 'prepare_create_work_order',
  description:
    'Prepare a new job (work order) for a customer by customer name, site name and job type name, with an optional title, description, priority and due date. The person confirms before it is created.',
  permission: 'work_order.manage',
  dataClass: 'company_operational',
  inputSchema: z.object({
    customerName: name,
    siteName: name.optional(),
    jobTypeName: name,
    title: name.optional(),
    description: z.string().trim().max(2000).optional(),
    priority: z.enum(WORK_ORDER_PRIORITIES).optional(),
    /** `YYYY-MM-DD` or a full ISO instant. */
    dueBy: z.string().trim().max(40).optional(),
  }),
  payloadSchema: workOrderPayload,
  payloadSchemaVersion: 1,
  async prepare(context, input) {
    const l = context.locale;
    const customers = await context.tx.customers.list({ text: input.customerName, limit: 5 });
    const customer =
      customers.items.find(
        (candidate) => candidate.name.trim().toLowerCase() === input.customerName.toLowerCase(),
      ) ?? (customers.items.length === 1 ? customers.items[0] : undefined);
    if (customer === undefined) {
      throw unprocessable('customer_unknown', 'No single customer matches that name.', [
        { field: 'customerName', code: 'not_found', message: 'Name the customer exactly.' },
      ]);
    }
    const sites = (
      await context.tx.sites.list({ customerId: customer.id, limit: 50 })
    ).items.filter((site) => site.archivedAt === null);
    const site =
      input.siteName === undefined
        ? sites.length === 1
          ? sites[0]
          : undefined
        : sites.find(
            (candidate) => candidate.name.trim().toLowerCase() === input.siteName?.toLowerCase(),
          );
    if (site === undefined) {
      throw unprocessable('site_not_customers', 'Name one of the customer’s sites.', [
        { field: 'siteName', code: 'not_found', message: 'Name the site exactly.' },
      ]);
    }
    const jobTypes = await context.tx.jobTypes.list();
    const jobType = jobTypes.find(
      (candidate) =>
        candidate.name.trim().toLowerCase() === input.jobTypeName.toLowerCase() ||
        candidate.code.toLowerCase() === input.jobTypeName.toLowerCase(),
    );
    if (jobType === undefined) {
      throw unprocessable('job_type_unknown', 'No job type has that name.', [
        { field: 'jobTypeName', code: 'not_found', message: 'Name the job type exactly.' },
      ]);
    }
    let dueBy: string | null = null;
    if (input.dueBy !== undefined && input.dueBy !== '') {
      const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(input.dueBy)
        ? new Date(`${input.dueBy}T17:00:00Z`)
        : new Date(input.dueBy);
      if (Number.isNaN(parsed.getTime())) {
        throw unprocessable('due_window_invalid', 'The due date could not be read.', [
          { field: 'dueBy', code: 'due_window_invalid', message: 'Use YYYY-MM-DD.' },
        ]);
      }
      dueBy = parsed.toISOString();
    }
    const payload = workOrderPayload.parse({
      customerId: customer.id,
      siteId: site.id,
      jobTypeId: jobType.id,
      title: input.title ?? null,
      description: input.description ?? null,
      priority: input.priority ?? null,
      dueBy,
    });
    const preview: ActionPreview = {
      title: previewLabel(
        l,
        `Create a ${jobType.name} job for ${customer.name}`,
        `إنشاء مهمة «${jobType.name}» للعميل ${customer.name}`,
      ),
      fields: [
        { label: previewLabel(l, 'Customer', 'العميل'), value: customer.name },
        { label: previewLabel(l, 'Site', 'الموقع'), value: site.name },
        { label: previewLabel(l, 'Job type', 'نوع المهمة'), value: jobType.name },
        { label: previewLabel(l, 'Title', 'العنوان'), value: payload.title ?? jobType.name },
        {
          label: previewLabel(l, 'Priority', 'الأولوية'),
          value: payload.priority ?? jobType.defaultPriority,
        },
        ...(dueBy === null ? [] : [{ label: previewLabel(l, 'Due by', 'الموعد'), value: dueBy }]),
      ],
      warnings:
        customer.status === 'on_hold'
          ? [previewLabel(l, 'This customer is on hold.', 'هذا العميل مُعلَّق.')]
          : customer.status === 'closed'
            ? [
                previewLabel(
                  l,
                  'This customer is closed and takes no new work.',
                  'هذا العميل مُغلق ولا يقبل عملًا جديدًا.',
                ),
              ]
            : [],
    };
    return {
      payload,
      preview,
      resourceVersions: { customerStatus: customer.status, siteArchived: site.archivedAt !== null },
    };
  },
  async execute({ context, tx, proposalId }, payload) {
    const job = await createWorkOrder(tx, context, {
      customerId: payload.customerId,
      siteId: payload.siteId,
      jobTypeId: payload.jobTypeId,
      ...(payload.title === null ? {} : { title: payload.title }),
      ...(payload.description === null ? {} : { description: payload.description }),
      ...(payload.priority === null ? {} : { priority: payload.priority }),
      ...(payload.dueBy === null ? {} : { dueBy: payload.dueBy }),
      acknowledgeOnHold: true,
    });
    await tx.auditLog.append({
      actorKind: 'tenant_user',
      actorId: context.principal.userId,
      actorLabel: context.principal.userId,
      action: 'work_order.created_by_assistant',
      resourceType: 'work_order',
      resourceId: job.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { source: 'ai_assistant', proposalId },
    });
    return {
      resourceType: 'work_order',
      resourceId: job.id,
      summary: `Job ${formatWorkOrderReference(job.reference)} created.`,
      appRoute: 'workOrders',
    };
  },
  async verify(context, payload, versions) {
    const customer = await context.tx.customers.find(payload.customerId);
    const site = await context.tx.sites.find(payload.siteId);
    return (
      customer !== undefined &&
      customer.status === versions.customerStatus &&
      site !== undefined &&
      (site.archivedAt !== null) === versions.siteArchived
    );
  },
});

// ---------------------------------------------------------------------------
// Create a CRM activity
// ---------------------------------------------------------------------------

const activityPayload = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  subject: name,
  detail: z.string().trim().max(2000).nullable(),
  dueAt: z.iso.datetime().nullable(),
  leadId: z.uuid().nullable(),
  customerId: z.uuid().nullable(),
  opportunityId: z.uuid().nullable(),
});

const createActivity = defineAction({
  key: 'prepare_create_crm_activity',
  description:
    'Prepare a CRM follow-up (call, email, meeting, note, follow-up or task) linked to a customer, lead or opportunity by name, with an optional due date. Assigned to the person asking. The person confirms before it is saved.',
  permission: 'crm.activity.manage',
  feature: 'crm',
  dataClass: 'company_operational',
  inputSchema: z.object({
    kind: z.enum(ACTIVITY_KINDS).default('follow_up'),
    subject: name,
    detail: z.string().trim().max(2000).optional(),
    customerName: name.optional(),
    leadName: name.optional(),
    opportunityTitle: name.optional(),
    /** `YYYY-MM-DD` or a full ISO instant. */
    dueAt: z.string().trim().max(40).optional(),
  }),
  payloadSchema: activityPayload,
  payloadSchemaVersion: 1,
  async prepare(context, input) {
    const l = context.locale;
    let customerId: string | null = null;
    let leadId: string | null = null;
    let opportunityId: string | null = null;
    let linkedTo: string;
    if (input.customerName !== undefined) {
      const page = await context.tx.customers.list({ text: input.customerName, limit: 5 });
      const customer =
        page.items.find(
          (candidate) => candidate.name.trim().toLowerCase() === input.customerName?.toLowerCase(),
        ) ?? (page.items.length === 1 ? page.items[0] : undefined);
      if (customer === undefined) {
        throw unprocessable('link_not_found', 'No single customer matches that name.');
      }
      customerId = customer.id;
      linkedTo = customer.name;
    } else if (input.opportunityTitle !== undefined) {
      const page = await context.tx.crmOpportunities.list({
        text: input.opportunityTitle,
        limit: 5,
      });
      const opportunity =
        page.items.find(
          (candidate) =>
            candidate.title.trim().toLowerCase() === input.opportunityTitle?.toLowerCase(),
        ) ?? (page.items.length === 1 ? page.items[0] : undefined);
      if (opportunity === undefined) {
        throw unprocessable('link_not_found', 'No single opportunity matches that title.');
      }
      opportunityId = opportunity.id;
      linkedTo = opportunity.title;
    } else if (input.leadName !== undefined) {
      const page = await context.tx.crmLeads.list({ text: input.leadName, limit: 5 });
      const lead =
        page.items.find(
          (candidate) =>
            candidate.displayName.trim().toLowerCase() === input.leadName?.toLowerCase() ||
            (candidate.companyName ?? '').trim().toLowerCase() === input.leadName?.toLowerCase(),
        ) ?? (page.items.length === 1 ? page.items[0] : undefined);
      if (lead === undefined) {
        throw unprocessable('link_not_found', 'No single lead matches that name.');
      }
      leadId = lead.id;
      linkedTo = lead.displayName;
    } else {
      throw unprocessable('link_required', 'Link it to a customer, a lead or an opportunity.');
    }
    let dueAt: string | null = null;
    if (input.dueAt !== undefined && input.dueAt !== '') {
      const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(input.dueAt)
        ? new Date(`${input.dueAt}T09:00:00Z`)
        : new Date(input.dueAt);
      if (Number.isNaN(parsed.getTime())) {
        throw unprocessable('ai_validation_failed', 'The due date could not be read.');
      }
      dueAt = parsed.toISOString();
    }
    const payload = activityPayload.parse({
      kind: input.kind,
      subject: input.subject,
      detail: input.detail ?? null,
      dueAt,
      leadId,
      customerId,
      opportunityId,
    });
    const preview: ActionPreview = {
      title: previewLabel(
        l,
        `Create a ${payload.kind} for ${linkedTo}`,
        `إنشاء ${payload.kind} لـ ${linkedTo}`,
      ),
      fields: [
        { label: previewLabel(l, 'Subject', 'الموضوع'), value: payload.subject },
        { label: previewLabel(l, 'Linked to', 'مرتبط بـ'), value: linkedTo },
        ...(dueAt === null ? [] : [{ label: previewLabel(l, 'Due', 'الموعد'), value: dueAt }]),
      ],
      warnings: [],
    };
    return { payload, preview, resourceVersions: {} };
  },
  async execute({ context, tx, proposalId }, payload) {
    await requireAssignableMember(tx, context.principal.userId);
    const links = {
      leadIds: payload.leadId === null ? [] : [payload.leadId],
      customerIds: payload.customerId === null ? [] : [payload.customerId],
      opportunityIds: payload.opportunityId === null ? [] : [payload.opportunityId],
    };
    const activity = await tx.crmActivities.create(
      {
        kind: payload.kind,
        subject: payload.subject,
        detail: payload.detail,
        assignedTo: context.principal.userId,
        dueAt: payload.dueAt === null ? null : new Date(payload.dueAt),
        done: payload.kind === 'note',
      },
      links,
      context.principal.userId,
    );
    await crmAudit(tx, context, 'crm_activity.created', 'crm_activity', activity.id, {
      kind: activity.kind,
      ...links,
      source: 'ai_assistant',
      proposalId,
    });
    return {
      resourceType: 'crm_activity',
      resourceId: activity.id,
      summary: `Activity “${activity.subject}” created.`,
      appRoute: 'activities',
    };
  },
  async verify(context, payload) {
    if (payload.customerId !== null) {
      return (await context.tx.customers.find(payload.customerId)) !== undefined;
    }
    if (payload.opportunityId !== null) {
      return (await context.tx.crmOpportunities.find(payload.opportunityId)) !== undefined;
    }
    if (payload.leadId !== null) {
      return (await context.tx.crmLeads.find(payload.leadId)) !== undefined;
    }
    return false;
  },
});

// ---------------------------------------------------------------------------
// Move an opportunity to another stage
// ---------------------------------------------------------------------------

const stagePayload = z.object({
  opportunityId: z.uuid(),
  stageId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  lostReason: z.string().trim().max(1000).nullable(),
});

const moveOpportunity = defineAction({
  key: 'prepare_update_crm_opportunity_stage',
  description:
    'Prepare moving an opportunity (by title) to another stage of its pipeline (by stage name), with a reason when the stage means lost. The person confirms before it moves.',
  permission: 'crm.opportunity.manage',
  feature: 'crm',
  dataClass: 'company_operational',
  inputSchema: z.object({
    opportunityTitle: name,
    stageName: name,
    lostReason: z.string().trim().max(1000).optional(),
  }),
  payloadSchema: stagePayload,
  payloadSchemaVersion: 1,
  async prepare(context, input) {
    const l = context.locale;
    const page = await context.tx.crmOpportunities.list({ text: input.opportunityTitle, limit: 5 });
    const opportunity =
      page.items.find(
        (candidate) =>
          candidate.title.trim().toLowerCase() === input.opportunityTitle.toLowerCase(),
      ) ?? (page.items.length === 1 ? page.items[0] : undefined);
    if (opportunity === undefined) {
      throw unprocessable('link_not_found', 'No single opportunity matches that title.');
    }
    if (opportunity.archivedAt !== null) {
      throw unprocessable('opportunity_archived', 'Restore this opportunity before moving it.');
    }
    const stages = await context.tx.crmPipelines.stages(opportunity.pipelineId);
    const from = stages.find((stage) => stage.id === opportunity.stageId);
    const to = stages.find(
      (stage) =>
        stage.archivedAt === null &&
        (stage.label.trim().toLowerCase() === input.stageName.toLowerCase() ||
          stage.key.toLowerCase() === input.stageName.toLowerCase()),
    );
    if (from === undefined || to === undefined || !opportunityMoveAllowed(from, to)) {
      throw unprocessable('invalid_transition', 'Name another live stage of this pipeline.');
    }
    const lostReason =
      input.lostReason === undefined || input.lostReason === '' ? null : input.lostReason;
    if (to.outcome === 'lost' && lostReason === null) {
      throw unprocessable('lost_reason_required', 'Say why it was lost.');
    }
    const payload = stagePayload.parse({
      opportunityId: opportunity.id,
      stageId: to.id,
      expectedVersion: opportunity.version,
      lostReason,
    });
    const preview: ActionPreview = {
      title: previewLabel(
        l,
        `Move “${opportunity.title}” from ${from.label} to ${to.label}`,
        `نقل «${opportunity.title}» من ${from.label} إلى ${to.label}`,
      ),
      fields: [
        { label: previewLabel(l, 'Opportunity', 'الفرصة'), value: opportunity.title },
        { label: previewLabel(l, 'From', 'من'), value: from.label },
        { label: previewLabel(l, 'To', 'إلى'), value: to.label },
        ...(lostReason === null
          ? []
          : [{ label: previewLabel(l, 'Reason', 'السبب'), value: lostReason }]),
      ],
      warnings:
        to.outcome === 'won' || to.outcome === 'lost'
          ? [previewLabel(l, 'This closes the opportunity.', 'هذا يُغلق الفرصة.')]
          : [],
    };
    return {
      payload,
      preview,
      resourceVersions: { version: opportunity.version, stageId: from.id },
    };
  },
  async execute({ context, tx, proposalId }, payload) {
    const current = await tx.crmOpportunities.find(payload.opportunityId);
    if (current?.archivedAt !== null) {
      throw unprocessable('opportunity_archived', 'This opportunity is no longer available.');
    }
    const [from, to] = await Promise.all([
      tx.crmPipelines.findStage(current.stageId),
      tx.crmPipelines.findStage(payload.stageId),
    ]);
    if (from === undefined || to === undefined || !opportunityMoveAllowed(from, to)) {
      throw unprocessable('invalid_transition', 'That stage is no longer available.');
    }
    const kind = opportunityEventKind(from.outcome, to.outcome);
    const moved = await tx.crmOpportunities.move(current.id, payload.expectedVersion, {
      from,
      to,
      kind,
      lostReason: payload.lostReason,
      actorId: context.principal.userId,
    });
    if (typeof moved === 'string') {
      throw unprocessable('version_conflict', 'The opportunity changed since it was read.');
    }
    await crmAudit(tx, context, `crm_opportunity.${kind}`, 'crm_opportunity', moved.id, {
      from: from.key,
      to: to.key,
      ...(payload.lostReason === null ? {} : { lostReason: payload.lostReason }),
      source: 'ai_assistant',
      proposalId,
    });
    return {
      resourceType: 'crm_opportunity',
      resourceId: moved.id,
      summary: `“${moved.title}” moved to ${to.label}.`,
      appRoute: 'opportunities',
    };
  },
  async verify(context, payload, versions) {
    const current = await context.tx.crmOpportunities.find(payload.opportunityId);
    return (
      current !== undefined &&
      current.version === versions.version &&
      current.stageId === versions.stageId &&
      current.archivedAt === null
    );
  },
});

export const ACTION_CATALOGUE: readonly AnyAiAction[] = [
  createCustomer,
  createWorkOrderAction,
  createActivity,
  moveOpportunity,
];
