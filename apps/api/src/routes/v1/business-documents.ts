import { randomBytes, randomUUID } from 'node:crypto';
import {
  holds,
  jobTimes,
  type ModuleFeature,
  type Permission,
  type Principal,
} from '@integr8/core';
import {
  type BusinessDocumentKind,
  type DocumentFieldValue,
  type DocumentRecord,
  getPlatformDataSource,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import {
  type BusinessDocumentData,
  type BusinessIssuer,
  type BusinessLocale,
  JOB_REPORT_MAX_PHOTOS,
} from '@integr8/document-render';
import { ar, en } from '@integr8/i18n/core';
import { z } from 'zod';
import {
  BUSINESS_DOCUMENT_ATTEMPTS,
  BUSINESS_DOCUMENT_QUEUE,
  type BusinessDocumentJob,
} from '../../documents/business.js';
import { documentLink } from '../../documents/render.js';
import { deliverBusinessDocument } from '../../email/deliver.js';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { FeatureDisabledError, isFeatureEnabled } from '../../http/features.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { planFor } from '../../http/suspension.js';
import { assertUploadFits } from '../../media/quota.js';
import { getStorage } from '../../media/tenant-storage.js';
import { audit, documentBodies, documentFileLink, documentSchema } from './documents.js';
import { companyName, invoiceDetail } from './finance-invoices.js';
import { peopleOf, personBody, readableWorkOrder } from './operations.js';
import { orderDetail, seesPrices } from './purchasing.js';
import { hashToken, quoteDetail } from './sales-quotes.js';
import { detailBody } from './work-orders.js';

/**
 * Business PDFs (1.3.0, decision 11): a quote, an invoice, a purchase order or
 * a job report, printed by the server in the company's look and kept in the
 * documents register, next to the PDFs made from submissions and the ones
 * uploaded. Printing from the browser stays as it was.
 *
 * Each kind follows its own module's rules, and the register's:
 *
 *   kind            module       see its PDFs         make, email
 *   quote           sales        sales.read           sales.manage
 *   invoice         finance      finance.read         finance.manage
 *   purchase_order  purchasing   seeing PO prices     purchasing.manage
 *   job_report      (jobs)       reading the job      reading it and working or managing jobs;
 *                                                     emailing: work_order.manage
 *
 * and every one needs the `documents` module, which keeps the register. Only
 * a record that has left draft is printed: a draft is printed from the
 * browser. Like every new document, a business PDF starts not shareable
 * (0067): its QR code's own page opens only once someone with
 * `document.upload` switches sharing on, here or in the register. A quote
 * printed from the link the issue step handed over carries that link instead,
 * which has its own rules (ADR-0006).
 */

const TAGS = ['documents'];
const DOWNLOAD_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const kindSchema = z.enum(['quote', 'invoice', 'purchase_order', 'job_report']);

interface KindRules {
  /** The module the record belongs to; null for jobs, which every company has. */
  feature: ModuleFeature | null;
  /** May see this kind's PDFs, given the record is one the seat may read. */
  read: (principal: Principal) => boolean;
  make: (principal: Principal) => boolean;
  email: (principal: Principal) => boolean;
}

const RULES: Readonly<Record<BusinessDocumentKind, KindRules>> = {
  quote: {
    feature: 'sales',
    read: (principal) => holds(principal, 'sales.read'),
    make: (principal) => holds(principal, 'sales.manage'),
    email: (principal) => holds(principal, 'sales.manage'),
  },
  invoice: {
    feature: 'finance',
    read: (principal) => holds(principal, 'finance.read'),
    make: (principal) => holds(principal, 'finance.manage'),
    email: (principal) => holds(principal, 'finance.manage'),
  },
  purchase_order: {
    feature: 'purchasing',
    // The PDF prints prices; only a seat that sees them sees it.
    read: (principal) => holds(principal, 'purchasing.read') && seesPrices(principal),
    make: (principal) => holds(principal, 'purchasing.manage'),
    email: (principal) => holds(principal, 'purchasing.manage'),
  },
  job_report: {
    feature: null,
    read: (principal) => holds(principal, 'customer.read'),
    // A viewer reads jobs but changes nothing, a stored PDF included.
    make: (principal) =>
      holds(principal, 'customer.read') &&
      (holds(principal, 'work_order.manage') || holds(principal, 'work_order.progress')),
    email: (principal) => holds(principal, 'work_order.manage'),
  },
};

/** Every permission that opens one of the doors, for the route's own check. */
const READ_PERMISSIONS: Permission[] = [
  'sales.read',
  'finance.read',
  'purchasing.read',
  'customer.read',
];
const MAKE_PERMISSIONS: Permission[] = [
  'sales.manage',
  'finance.manage',
  'purchasing.manage',
  'work_order.manage',
  'work_order.progress',
];

type Action = 'read' | 'make' | 'email';

/** Refuses a seat or a company that may not do this with this kind; 404 hides a record it may not read. */
async function assertKind(
  context: RequestContext,
  kind: BusinessDocumentKind,
  action: Action,
): Promise<void> {
  const rules = RULES[kind];
  if (
    rules.feature !== null &&
    !(await isFeatureEnabled(context.principal.tenantId, rules.feature))
  ) {
    throw new FeatureDisabledError(rules.feature);
  }
  if (!rules[action](context.principal)) {
    throw forbidden('You do not have permission to do that.');
  }
}

// ---------------------------------------------------------------------------
// Reading the records
// ---------------------------------------------------------------------------

interface Snapshot {
  data: BusinessDocumentData;
  /** What the register calls it, in the PDF's language. */
  title: string;
  customerId: string | null;
  /** The customer's or supplier's name, searchable in the register. */
  partyName: string;
}

/** The company as its documents name it: the finance settings' legal details, else its name. */
async function issuerOf(
  tx: TenantTransaction,
  tenantId: string,
): Promise<{ issuer: BusinessIssuer; footer: string | null; paymentInstructions: string | null }> {
  const settings = await tx.financeInvoices.settings();
  return {
    issuer: {
      name: settings.legalName ?? (await companyName(tenantId)),
      address: settings.address,
      taxReference: settings.taxReference,
    },
    footer: settings.footer,
    paymentInstructions: settings.paymentInstructions,
  };
}

function words(locale: BusinessLocale) {
  return (locale === 'ar' ? ar : en).businessPdfs;
}

function fillIn(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, name: string) => values[name] ?? whole);
}

/** The record as the person asking sees it, or 404 when they may not read it. */
async function snapshotOf(
  tx: TenantTransaction,
  context: RequestContext,
  kind: BusinessDocumentKind,
  recordId: string,
  locale: BusinessLocale,
): Promise<Snapshot> {
  const { principal } = context;
  const render = words(locale).render;
  switch (kind) {
    case 'quote': {
      const quote = await tx.salesQuotes.findQuote(recordId);
      if (quote === undefined) {
        throw notFound('This quote does not exist.');
      }
      if (quote.status === 'draft') {
        throw conflict(
          'business_document_draft',
          'A draft cannot be made into a PDF; print it from the browser.',
        );
      }
      const detail = await quoteDetail(tx, principal, quote);
      const { issuer, footer } = await issuerOf(tx, principal.tenantId);
      const q = detail.quote;
      return {
        data: {
          kind: 'quote',
          reference: q.reference,
          issuer,
          footer,
          title: q.title,
          status: q.status,
          issuedAt: q.issuedAt,
          validUntil: q.validUntil,
          customerName: q.issuedTo?.customerName ?? q.customer.name,
          customerAddress: q.issuedTo?.customerAddress ?? null,
          contactName: q.issuedTo?.contactName ?? q.contact?.name ?? null,
          introduction: q.introduction,
          terms: q.terms,
          currencyCode: q.currencyCode,
          lines: detail.lines,
          totals: q.totals,
          answer:
            q.answer === null
              ? null
              : { status: q.answer.status, at: q.answer.at, name: q.answer.name },
        },
        title: fillIn(render.quote.title, { reference: q.reference }),
        customerId: q.customer.id,
        partyName: q.issuedTo?.customerName ?? q.customer.name,
      };
    }
    case 'invoice': {
      const invoice = await tx.financeInvoices.findInvoice(recordId);
      if (invoice === undefined) {
        throw notFound('This invoice does not exist.');
      }
      if (invoice.status === 'draft' || invoice.reference === null) {
        throw conflict(
          'business_document_draft',
          'A draft cannot be made into a PDF; print it from the browser.',
        );
      }
      const detail = await invoiceDetail(tx, principal, invoice);
      const own = await issuerOf(tx, principal.tenantId);
      const i = detail.invoice;
      const reference = i.reference ?? '';
      return {
        data: {
          kind: 'invoice',
          reference,
          issuer:
            i.issuer === null
              ? own.issuer
              : {
                  name: i.issuer.name,
                  address: i.issuer.address,
                  taxReference: i.issuer.taxReference,
                },
          footer: i.issuer?.footer ?? own.footer,
          status: i.status,
          issueDate: i.issueDate,
          dueDate: i.dueDate,
          customerName: i.billedTo?.customerName ?? i.customer.name,
          customerAddress: i.billedTo?.customerAddress ?? null,
          contactName: i.billedTo?.contactName ?? i.contact?.name ?? null,
          notes: i.notes,
          paymentInstructions: i.issuer?.paymentInstructions ?? own.paymentInstructions,
          currencyCode: i.currencyCode,
          lines: detail.lines,
          totals: i.totals,
          amounts: i.amounts,
          creditNotes: detail.creditNotes
            .filter((note) => note.status === 'issued' && note.reference !== null)
            .map((note) => ({
              reference: note.reference ?? '',
              issueDate: note.issueDate,
              total: note.total,
            })),
          payments: detail.payments.map((payment) => ({
            reference: payment.receipt.reference,
            receivedOn: payment.receivedOn,
            amount: payment.amount,
          })),
        },
        title: fillIn(render.invoice.title, { reference }),
        customerId: i.customer.id,
        partyName: i.billedTo?.customerName ?? i.customer.name,
      };
    }
    case 'purchase_order': {
      const order = await tx.inventoryPurchasing.findOrder(recordId);
      if (order === undefined) {
        throw notFound('This purchase order does not exist.');
      }
      if (order.status === 'draft') {
        throw conflict(
          'business_document_draft',
          'A draft cannot be made into a PDF; print it from the browser.',
        );
      }
      const detail = await orderDetail(tx, context, order);
      const { footer } = await issuerOf(tx, principal.tenantId);
      const { buyer, supplier } = detail.parties;
      return {
        data: {
          kind: 'purchase_order',
          reference: detail.order.reference,
          issuer: buyer,
          footer,
          status: detail.order.status,
          orderedAt: detail.order.approvedAt ?? detail.order.createdAt,
          expectedDate: detail.order.expectedDate,
          supplier,
          deliverTo: detail.order.deliveryLocation?.name ?? null,
          notes: detail.order.notes,
          currencyCode: detail.order.currencyCode,
          lines: detail.lines.map((line) => ({
            description: line.description,
            sku: line.item.sku,
            quantity: line.quantityOrdered,
            unit: line.item.unit,
            unitPrice: line.unitPrice,
            taxRateBp: line.taxRateBp,
            subtotal: line.subtotal,
          })),
          totals: detail.order.totals,
        },
        title: fillIn(render.purchaseOrder.title, { reference: detail.order.reference }),
        customerId: null,
        partyName: supplier.name,
      };
    }
    case 'job_report':
      return jobSnapshot(tx, context, recordId, locale);
  }
}

async function jobSnapshot(
  tx: TenantTransaction,
  context: RequestContext,
  workOrderId: string,
  locale: BusinessLocale,
): Promise<Snapshot> {
  const { principal } = context;
  const job = await readableWorkOrder(tx, principal, workOrderId);
  const detail = await detailBody(tx, principal, job);
  const [{ issuer, footer }, people] = await Promise.all([
    issuerOf(tx, principal.tenantId),
    peopleOf(tx),
  ]);
  const signatureId = detail.execution.signoff?.fileId ?? null;
  const photos = detail.attachments
    .filter(
      (attachment) =>
        attachment.kind === 'photo' &&
        attachment.contentType.startsWith('image/') &&
        attachment.fileId !== signatureId,
    )
    .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage));
  const submissions = await Promise.all(
    detail.forms.map(async (form) => {
      if (form.submission === null) {
        return { submittedBy: null, documents: [] as string[] };
      }
      const [submission, documents] = await Promise.all([
        tx.submissions.findById(form.submission.id),
        tx.documents.list({ submissionId: form.submission.id, state: 'active', limit: 5 }),
      ]);
      return {
        submittedBy:
          submission === undefined ? null : personBody(submission.submittedBy, people).name,
        documents: documents.map((document) => document.title),
      };
    }),
  );
  const changes = detail.events.flatMap((event) =>
    event.kind === 'transitioned' && event.fromState !== null && event.toState !== null
      ? [{ fromState: event.fromState, toState: event.toState, occurredAt: event.occurredAt }]
      : [],
  );
  const times = jobTimes(changes);
  const { workOrder, site } = detail;
  const reference = workOrder.referenceLabel;
  return {
    data: {
      kind: 'job_report',
      reference,
      issuer,
      footer,
      title: workOrder.title,
      state: workOrder.state,
      priority: workOrder.priority,
      jobType: detail.jobType.name,
      createdAt: workOrder.createdAt,
      completedAt: workOrder.completedAt,
      reviewedAt: workOrder.reviewedAt,
      description: workOrder.description,
      customer: {
        name: detail.customer.name,
        accountNumber: detail.customer.accountNumber,
        phone: detail.customer.phone,
      },
      site: {
        name: site.name,
        address: site.address,
        location:
          site.location === null
            ? null
            : {
                latitude: String(site.location.latitude),
                longitude: String(site.location.longitude),
              },
      },
      siteContact:
        detail.siteContact === null
          ? null
          : {
              name: detail.siteContact.name,
              phone: detail.siteContact.phone,
              email: detail.siteContact.email,
            },
      notes: detail.comments
        .filter((comment) => comment.visibility === 'customer')
        .map((comment) => ({
          author: comment.author.name,
          at: comment.createdAt,
          body: comment.body,
        })),
      visits: detail.visits.map((visit) => ({
        startsAt: visit.startsAt,
        endsAt: visit.endsAt,
        status: visit.status,
        engineers: visit.assignees.map((person) => person.name),
        completedAt: visit.completedAt,
      })),
      times: {
        arrivedAt: times.arrivedAt?.toISOString() ?? null,
        startedAt: times.startedAt?.toISOString() ?? null,
        completedAt: times.completedAt?.toISOString() ?? null,
        travelMs: times.travelMs,
        onSiteMs: times.onSiteMs,
        workMs: times.workMs,
        waitingMs: times.waitingMs,
      },
      parts: detail.materials
        .filter((material) => material.status === 'posted')
        .map((material) => ({
          name: material.item.name,
          sku: material.item.sku,
          quantity: netQuantity(material.quantity, material.returnedQuantity),
          unit: material.item.unit,
          serials: (material.lots ?? [])
            .filter((lot) => lot.kind === 'serial')
            .map((lot) => lot.code),
          batches: (material.lots ?? [])
            .filter((lot) => lot.kind === 'batch')
            .map((lot) => lot.code),
        }))
        .filter((part) => Number(part.quantity) > 0),
      forms: detail.forms.map((form, index) => ({
        title: form.title,
        status: form.submission?.status ?? 'missing',
        submittedBy: submissions[index]?.submittedBy ?? null,
        submittedAt: form.submission?.submittedAt ?? null,
        documents: submissions[index]?.documents ?? [],
      })),
      checklist: detail.checklist.map((item) => ({ label: item.label, done: item.done })),
      photos: photos.slice(0, JOB_REPORT_MAX_PHOTOS).map((photo) => ({
        fileId: photo.fileId,
        title: photo.title,
        stage: photo.stage,
      })),
      morePhotos: Math.max(0, photos.length - JOB_REPORT_MAX_PHOTOS),
      signoff:
        detail.execution.signoff === null
          ? null
          : {
              signedAt: detail.execution.signoff.signedAt,
              name: detail.execution.signoff.name,
              role: detail.execution.signoff.role,
              signatureFileId: signatureId,
              unavailableReason: detail.execution.signoff.unavailableReason,
            },
    },
    title: `${words(locale).render.job.title} · ${reference}`,
    customerId: job.customerId,
    partyName: detail.customer.name,
  };
}

function stageOrder(stage: 'before' | 'after' | null): number {
  return stage === 'before' ? 0 : stage === 'after' ? 1 : 2;
}

/** Used less returned, as a decimal string; the quantities are decimal strings with up to four places. */
function netQuantity(quantity: string, returned: string): string {
  const scale = 10_000;
  const net = Math.round(Number(quantity) * scale) - Math.round(Number(returned) * scale);
  return String(net / scale);
}

/** The record a business PDF names, read again: 404 when this seat may not read it. */
async function assertRecordReadable(
  tx: TenantTransaction,
  context: RequestContext,
  kind: BusinessDocumentKind,
  recordId: string,
): Promise<void> {
  switch (kind) {
    case 'quote':
      if ((await tx.salesQuotes.findQuote(recordId)) === undefined) {
        throw notFound('This quote does not exist.');
      }
      return;
    case 'invoice':
      if ((await tx.financeInvoices.findInvoice(recordId)) === undefined) {
        throw notFound('This invoice does not exist.');
      }
      return;
    case 'purchase_order':
      if ((await tx.inventoryPurchasing.findOrder(recordId)) === undefined) {
        throw notFound('This purchase order does not exist.');
      }
      return;
    case 'job_report':
      await readableWorkOrder(tx, context.principal, recordId);
      return;
  }
}

/** A business PDF this seat may reach, by its id. */
async function businessDocument(
  tx: TenantTransaction,
  context: RequestContext,
  documentId: string,
  action: Action,
): Promise<DocumentRecord & { record: NonNullable<DocumentRecord['record']> }> {
  const document = await tx.documents.find(documentId);
  if (document?.record === null || document === undefined) {
    throw notFound('This document does not exist.');
  }
  await assertKind(context, document.record.kind, action);
  await assertRecordReadable(tx, context, document.record.kind, document.record.id);
  return { ...document, record: document.record };
}

/** The language a company's documents are made in unless the person chooses. */
async function companyLocale(tx: TenantTransaction): Promise<BusinessLocale> {
  const settings = await tx.settings.get();
  return settings.locale.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

const FIELD_LABELS = {
  reference: { en: 'Reference', ar: 'المرجع' },
  customer: { en: 'Customer', ar: 'العميل' },
  supplier: { en: 'Supplier', ar: 'المورد' },
} as const;

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const canSchema = z.object({
  /** Make a new PDF of this record. */
  make: z.boolean(),
  /** Email a ready PDF to the customer or supplier. */
  email: z.boolean(),
  /** Make it shareable at once: its QR code's page opens it (`document.upload`). */
  share: z.boolean(),
});

const listSchema = z.object({
  items: z.array(documentSchema),
  can: canSchema,
  /** The address the record names for the customer or supplier, to email to. */
  email: z.string().nullable(),
  /** The language the company's documents are made in unless chosen. */
  language: z.enum(['en', 'ar']),
});

export const listBusinessDocumentsRoute = defineRoute({
  method: 'get',
  path: '/v1/business-documents',
  operationId: 'listBusinessDocuments',
  summary: 'The PDFs printed from one quote, invoice, purchase order or job',
  description:
    'Newest first, at most 20, with what this seat may do with the record’s PDFs. Each kind follows its module (a quote needs `sales.read`, an invoice `finance.read`, a purchase order a seat that sees its prices, a job report the right to read the job), and every one the `documents` module. 404 for a record this seat may not read.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: READ_PERMISSIONS,
  feature: 'documents',
  params: noSchema,
  query: z.object({ kind: kindSchema, recordId: z.uuid() }),
  body: noSchema,
  responses: {
    200: { description: 'The PDFs, and what may be done.', schema: listSchema },
    403: { description: 'The module is off (`feature_disabled`) or the seat may not.' },
    404: { description: 'No such record this seat may read.' },
  },
  handler: async ({ query }, context) => {
    await assertKind(context, query.kind, 'read');
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      await assertRecordReadable(tx, context, query.kind, query.recordId);
      const items = await tx.documents.list({
        record: { kind: query.kind, id: query.recordId },
        limit: 20,
      });
      const rules = RULES[query.kind];
      let email: string | null = null;
      if (rules.email(context.principal)) {
        email = await recipientOf(tx, query.kind, query.recordId);
      }
      return {
        items: await documentBodies(tx, context, items),
        can: {
          make: rules.make(context.principal),
          email: rules.email(context.principal),
          share: holds(context.principal, 'document.upload'),
        },
        email,
        language: await companyLocale(tx),
      };
    });
    return { status: 200, body };
  },
});

/**
 * The address a record names for whoever its PDF goes to: the contact the
 * quote or invoice was issued to, the supplier, the job's site contact or else
 * its customer. Read on its own, without the whole record.
 */
async function recipientOf(
  tx: TenantTransaction,
  kind: BusinessDocumentKind,
  recordId: string,
): Promise<string | null> {
  switch (kind) {
    case 'quote':
      return (await tx.salesQuotes.findQuote(recordId))?.contactEmail ?? null;
    case 'invoice':
      return (await tx.financeInvoices.findInvoice(recordId))?.contactEmail ?? null;
    case 'purchase_order': {
      const order = await tx.inventoryPurchasing.findOrder(recordId);
      return order === undefined
        ? null
        : ((await tx.inventoryPurchasing.findSupplier(order.supplierId))?.email ?? null);
    }
    case 'job_report': {
      const job = await tx.workOrders.find(recordId);
      if (job === undefined) {
        return null;
      }
      const site = await tx.sites.find(job.siteId);
      const contacts =
        site?.contactId == null ? [] : await tx.customers.findContacts([site.contactId]);
      return contacts[0]?.email ?? (await tx.customers.find(job.customerId))?.email ?? null;
    }
  }
}

export const createBusinessDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/business-documents',
  operationId: 'createBusinessDocument',
  summary: 'Print a quote, invoice, purchase order or job report as a PDF',
  description:
    'Takes the record as this seat sees it now and asks the worker to print it in the company’s look: answers 202 with the document pending, which becomes `ready` or `failed` like any document, and is kept in the register. `language` defaults to the company’s. A draft is refused (409 `business_document_draft`). The QR code opens the PDF’s own page, which shows it only once it is shareable; `shareable: true` needs `document.upload`. For a quote, `quoteLinkToken` (the token the issue step returned) prints the customer’s quote page in the QR code instead, if it is still the quote’s live link (422 `quote_link_invalid` if not). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: MAKE_PERMISSIONS,
  feature: 'documents',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    kind: kindSchema,
    recordId: z.uuid(),
    language: z.enum(['en', 'ar']).optional(),
    shareable: z.boolean().default(false),
    quoteLinkToken: z.string().min(20).max(200).optional(),
  }),
  responses: {
    202: { description: 'The document, pending.', schema: documentSchema },
    403: { description: 'The module is off, or the seat may not make (or share) it.' },
    404: { description: 'No such record this seat may read.' },
    409: {
      description:
        'A draft (`business_document_draft`), or storage full (`storage_quota_exceeded`).',
    },
    422: { description: 'The quote link is not this quote’s live link (`quote_link_invalid`).' },
    503: { description: 'No web address for the QR link (`document_link_unavailable`).' },
  },
  handler: async ({ body }, context) => {
    const { principal, config } = context;
    if (config.WEB_APP_URL === undefined) {
      throw new ApiError(
        503,
        'document_link_unavailable',
        'This server has no WEB_APP_URL, so a document’s QR code would have nowhere to point.',
      );
    }
    await assertKind(context, body.kind, 'make');
    if (body.shareable && !holds(principal, 'document.upload')) {
      throw forbidden('Only someone who may share documents can make one shareable.');
    }
    let quoteUrl: string | null = null;
    if (body.quoteLinkToken !== undefined) {
      const found = await getPlatformDataSource().publicQuotes.byTokenHash(
        hashToken(body.quoteLinkToken),
      );
      if (
        body.kind !== 'quote' ||
        found?.tenantId !== principal.tenantId ||
        found.quoteId !== body.recordId
      ) {
        throw unprocessable('quote_link_invalid', 'This is not the quote’s live link.', [
          { field: 'body.quoteLinkToken', code: 'quote_link_invalid', message: 'not live' },
        ]);
      }
      quoteUrl = `${config.WEB_APP_URL.replace(/\/+$/u, '')}/q/${body.quoteLinkToken}`;
    }
    // Refused now rather than after printing, when the company is already full.
    await assertUploadFits({
      plan: await planFor(principal.tenantId),
      usage: await withTenant(principal.tenantId, (tx) => tx.files.usage()),
      incomingBytes: 1,
    });
    const document = await withTenant(principal.tenantId, async (tx) => {
      const locale = body.language ?? (await companyLocale(tx));
      const snapshot = await snapshotOf(tx, context, body.kind, body.recordId, locale);
      const id = randomUUID();
      const publicCode = randomBytes(16).toString('base64url');
      const party = body.kind === 'purchase_order' ? 'supplier' : 'customer';
      const fields: DocumentFieldValue[] = [
        {
          key: 'reference',
          label: { ...FIELD_LABELS.reference },
          value: snapshot.data.reference,
          lookupRole: null,
        },
        {
          key: party,
          label: { ...FIELD_LABELS[party] },
          value: snapshot.partyName.slice(0, 500),
          lookupRole: null,
        },
      ];
      const created = await tx.documents.createBusiness({
        id,
        record: { kind: body.kind, id: body.recordId },
        title: snapshot.title.slice(0, 200),
        reference: snapshot.data.reference.slice(0, 100),
        customerId: snapshot.customerId,
        publicCode,
        shareable: body.shareable,
        by: principal.userId,
        fields,
      });
      const job: BusinessDocumentJob = {
        documentId: id,
        data: snapshot.data,
        locale,
        qrUrl: quoteUrl ?? documentLink(config, publicCode),
        qrOpensQuote: quoteUrl !== null,
      };
      await tx.jobs.enqueue({
        queue: BUSINESS_DOCUMENT_QUEUE,
        payload: { ...job },
        maxAttempts: BUSINESS_DOCUMENT_ATTEMPTS,
      });
      await audit(tx, context, 'document.business_created', 'document', id, {
        kind: body.kind,
        recordId: body.recordId,
        reference: snapshot.data.reference,
        language: locale,
        shareable: body.shareable,
        quoteLink: quoteUrl !== null,
      });
      const [shaped] = await documentBodies(tx, context, [created]);
      return shaped!;
    });
    return { status: 202, body: document };
  },
});

const documentParams = z.object({ documentId: z.uuid() });

export const getBusinessDocumentFileRoute = defineRoute({
  method: 'get',
  path: '/v1/business-documents/:documentId/file',
  operationId: 'getBusinessDocumentFile',
  summary: 'A link to a business PDF',
  description:
    'Five minutes long, like the register’s own link, for a seat that may see the record’s PDFs (see `listBusinessDocuments`). `disposition=attachment` saves it under its title.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: READ_PERMISSIONS,
  feature: 'documents',
  params: documentParams,
  query: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }),
  body: noSchema,
  responses: {
    200: {
      description: 'The link.',
      schema: z.object({ url: z.string(), expiresAt: z.iso.datetime() }),
    },
    404: { description: 'No such business PDF this seat may see, or it is not ready.' },
  },
  handler: async ({ params, query }, context) => {
    const document = await withTenant(context.principal.tenantId, (tx) =>
      businessDocument(tx, context, params.documentId, 'read'),
    );
    return {
      status: 200,
      body: await documentFileLink(
        context,
        context.principal.tenantId,
        document,
        query.disposition,
      ),
    };
  },
});

export const emailBusinessDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/business-documents/:documentId/email',
  operationId: 'emailBusinessDocument',
  summary: 'Email a business PDF to the customer or supplier',
  description:
    'Sends the ready PDF as an attachment, with the company’s name in the subject, in the company’s language, and replies going to the person who sent it. Who may: `sales.manage` for a quote, `finance.manage` for an invoice, `purchasing.manage` for a purchase order, `work_order.manage` for a job report. Answers whether it went: an email the provider refused is `sent: false` with the reason, not an error. Refused while the PDF is not ready (409 `document_not_ready`) or when it is larger than 10 MB (422 `document_too_large_to_email`). Recorded in the audit log. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: MAKE_PERMISSIONS,
  feature: 'documents',
  idempotent: true,
  params: documentParams,
  query: noSchema,
  body: z.object({
    to: z.email().max(254),
    message: z.string().trim().max(2000).optional(),
  }),
  responses: {
    200: {
      description: 'Whether it went.',
      schema: z.object({ sent: z.boolean(), problem: z.string().nullable() }),
    },
    404: { description: 'No such business PDF this seat may email.' },
    409: { description: 'The PDF is not ready yet (`document_not_ready`).' },
    422: { description: 'Too large to email (`document_too_large_to_email`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const found = await withTenant(principal.tenantId, async (tx) => {
      const document = await businessDocument(tx, context, params.documentId, 'email');
      if (document.status !== 'ready' || document.fileId === null) {
        throw conflict('document_not_ready', 'The PDF is not ready yet.');
      }
      if ((document.byteSize ?? 0) > DOWNLOAD_ATTACHMENT_MAX_BYTES) {
        throw unprocessable(
          'document_too_large_to_email',
          'This PDF is larger than 10 MB; download it and share it another way.',
          [{ field: 'params.documentId', code: 'document_too_large_to_email', message: '10 MB' }],
        );
      }
      const [file, sender, locale] = await Promise.all([
        tx.files.find(document.fileId),
        tx.tenantUsers.findByUserId(principal.userId),
        companyLocale(tx),
      ]);
      return { document, file, replyTo: sender?.email, locale };
    });
    const { document, file } = found;
    if (file?.deletedAt !== null) {
      throw notFound('This document has no file.');
    }
    const store = await getStorage(context.services.media, principal.tenantId);
    const bytes = await store.get(file.storageKey);
    if (bytes === undefined) {
      throw notFound('This document has no file.');
    }
    const delivery = await deliverBusinessDocument({
      sender: context.services.email,
      logger: context.logger,
      tenantId: principal.tenantId,
      to: body.to,
      companyName: await companyName(principal.tenantId),
      documentTitle: document.title,
      note: body.message ?? null,
      attachment: { filename: `${document.title}.pdf`, content: bytes },
      ...(found.replyTo === undefined ? {} : { replyTo: found.replyTo }),
      locale: found.locale,
    });
    await withTenant(principal.tenantId, (tx) =>
      audit(tx, context, 'document.emailed', 'document', document.id, {
        kind: document.record.kind,
        recordId: document.record.id,
        // Who it went to is the point of the record: the company sent its
        // document there, and may be asked where.
        to: body.to,
        sent: delivery.sent,
      }),
    );
    return { status: 200, body: delivery };
  },
});

export const businessDocumentRoutes = [
  listBusinessDocumentsRoute,
  createBusinessDocumentRoute,
  getBusinessDocumentFileRoute,
  emailBusinessDocumentRoute,
];
