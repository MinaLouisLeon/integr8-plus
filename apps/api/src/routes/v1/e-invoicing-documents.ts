import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ETA_DOCUMENT_STATES, ETA_ENVIRONMENTS, formatInvoiceReference } from '@integr8/core';
import { type EtaDocumentRecord, type TenantTransaction, withTenant } from '@integr8/db';
import {
  buildInvoiceDocument,
  canonicalDigest,
  canPrepareAgain,
  checkDocumentArithmetic,
  ETA_DOCUMENT_TYPE_INVOICE,
  formatDecimal,
  fromBase64,
  fromHex,
  invoiceReadiness,
  parseJsonText,
  type ReadinessIssue,
  toBase64,
  toHex,
  withSignature,
  writeJsonText,
} from '@integr8/eta';
import {
  CmsVerificationError,
  compileSchema,
  EtaApiError,
  verifyCadesBes,
} from '@integr8/eta/node';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import {
  checkStatus,
  ETA_RECONCILE_QUEUE,
  ETA_SUBMIT_QUEUE,
  readBuildInput,
} from '../../eta/documents.js';
import { ETA_SUBMIT_ATTEMPTS } from '../../eta/jobs.js';
import { environmentProblem, openEtaClient } from '../../eta/services.js';
import { crmAudit as audit } from './crm-shared.js';
import { etaFailure } from './e-invoicing.js';
import {
  documentSchema,
  documentView,
  FEATURE,
  notReady,
  refuseImpersonation,
  refuseProblem,
  TAGS,
} from './e-invoicing-shared.js';

/**
 * ETA documents (PLAN §3–§4): an invoice's readiness, preparing a document,
 * the signing request and the agent's side of it, submission, status,
 * resolution of an unknown outcome, cancellation and the ETA's PDF.
 *
 * The invoice is never changed by any of this. A document's state moves only
 * along `@integr8/eta`'s transitions, each move a single conditional update.
 */

const documentParams = z.object({ documentId: z.uuid() });

const readinessSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  params: z.record(z.string(), z.string()).optional(),
});

const signingRequestSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  internalId: z.string(),
  environment: z.enum(ETA_ENVIRONMENTS),
  digest: z.string(),
  nonce: z.string(),
  status: z.enum(['open', 'claimed', 'completed', 'cancelled', 'expired']),
  requestedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  claimedBy: z.uuid().nullable(),
  failure: z.string().nullable(),
});

const attemptSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  outcome: z.string(),
  httpStatus: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
  correlationId: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

const detailSchema = z.object({
  document: documentSchema,
  signingRequest: signingRequestSchema.nullable(),
  attempts: z.array(attemptSchema),
});

function details(issues: readonly ReadinessIssue[]) {
  return issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => ({
      field: issue.path,
      code: issue.code,
      message: issue.code,
      ...(issue.params === undefined ? {} : { params: issue.params }),
    }));
}

async function documentOrNotFound(
  tx: TenantTransaction,
  documentId: string,
): Promise<EtaDocumentRecord> {
  const document = await tx.eta.document(documentId);
  if (document === undefined) {
    throw notFound('No such ETA document.');
  }
  return document;
}

const stateConflict = (document: EtaDocumentRecord, wanted: string) =>
  conflict(
    'eta_state_conflict',
    `The document is ${document.state}; it must be ${wanted} for this. Reload to see where it is.`,
  );

function requestView(
  request: {
    id: string;
    documentId: string;
    digest: string;
    nonce: string;
    status: z.infer<typeof signingRequestSchema>['status'];
    requestedAt: Date;
    expiresAt: Date;
    claimedBy: string | null;
    failure: string | null;
  },
  document: EtaDocumentRecord,
  showNonce: boolean,
): z.infer<typeof signingRequestSchema> {
  return {
    id: request.id,
    documentId: request.documentId,
    internalId: document.internalId,
    environment: document.environment,
    digest: request.digest,
    // The nonce goes to the signing agent only.
    nonce: showNonce ? request.nonce : '',
    status: request.status,
    requestedAt: request.requestedAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    claimedBy: request.claimedBy,
    failure: request.failure,
  };
}

async function detail(tx: TenantTransaction, document: EtaDocumentRecord) {
  const [request, attempts] = await Promise.all([
    tx.eta.openSigningRequestFor(document.id),
    tx.eta.attempts(document.id),
  ]);
  return {
    document: documentView(document),
    signingRequest: request === undefined ? null : requestView(request, document, false),
    attempts: attempts.map((attempt) => ({
      id: attempt.id,
      kind: attempt.kind,
      outcome: attempt.outcome,
      httpStatus: attempt.httpStatus,
      errorCode: attempt.errorCode,
      message: attempt.message,
      correlationId: attempt.correlationId,
      startedAt: attempt.startedAt.toISOString(),
      finishedAt: attempt.finishedAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// An invoice's panel
// ---------------------------------------------------------------------------

const exchangeRateQuery = z.object({
  /** EGP per one unit of the invoice's currency; needed unless the invoice is in EGP. */
  exchangeRate: z
    .string()
    .regex(/^\d{1,9}(\.\d{1,5})?$/u, 'A positive decimal, up to five places')
    .optional(),
});

export const etaInvoiceRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/invoices/:invoiceId',
  operationId: 'getEtaInvoice',
  summary: 'An invoice’s e-invoicing panel: readiness and documents',
  description:
    'Readiness lists what stops the invoice becoming an ETA document (errors) and what deserves a look (warnings), by code. `documents` is every document made from it, newest first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: z.object({ invoiceId: z.uuid() }),
  query: exchangeRateQuery,
  body: noSchema,
  responses: {
    200: {
      description: 'The panel.',
      schema: z.object({
        enabled: z.boolean(),
        environment: z.enum(ETA_ENVIRONMENTS),
        readiness: z.array(readinessSchema),
        documents: z.array(documentSchema),
      }),
    },
    404: { description: 'No such invoice.' },
  },
  handler: async ({ params, query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const settings = await tx.eta.settings();
      const input = await readBuildInput(
        tx,
        settings,
        params.invoiceId,
        query.exchangeRate ?? null,
        formatInvoiceReference,
      );
      if (input === undefined) {
        throw notFound('No such invoice.');
      }
      const documents = await tx.eta.documentsForInvoice(params.invoiceId);
      return {
        enabled: settings.enabled,
        environment: settings.environment,
        readiness: invoiceReadiness(input),
        documents: documents.map(documentView),
      };
    });
    return { status: 200, body };
  },
});

export const prepareEtaDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/invoices/:invoiceId/prepare',
  operationId: 'prepareEtaDocument',
  summary: 'Make an unsigned ETA document from an issued invoice',
  description:
    'Snapshots the document text and its canonical SHA-256. A previous document that was never accepted (ready, awaiting signature, signed or failed) is superseded; one being sent, sent, valid or of unknown outcome is not (409 `eta_document_live`). 422 `eta_not_ready` with the readiness codes as details.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.prepare',
  feature: FEATURE,
  idempotent: true,
  params: z.object({ invoiceId: z.uuid() }),
  query: noSchema,
  body: exchangeRateQuery,
  responses: {
    201: { description: 'The document.', schema: documentSchema },
    404: { description: 'No such invoice.' },
    409: { description: 'E-invoicing is off, or a live document exists.' },
    422: { description: 'The invoice is not ready.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const prepared = await withTenant(principal.tenantId, async (tx) => {
      const settings = await tx.eta.settings();
      if (!settings.enabled) {
        refuseProblem('eta_disabled');
      }
      const problem = environmentProblem(context.config, settings.environment);
      if (problem !== null) {
        refuseProblem(problem);
      }
      const input = await readBuildInput(
        tx,
        settings,
        params.invoiceId,
        body.exchangeRate ?? null,
        formatInvoiceReference,
      );
      if (input === undefined) {
        throw notFound('No such invoice.');
      }
      const issues = invoiceReadiness(input);
      if (issues.some((issue) => issue.severity === 'error')) {
        throw notReady(details(issues));
      }
      const live = await tx.eta.liveDocumentForInvoice(params.invoiceId);
      if (live !== undefined) {
        if (!canPrepareAgain(live.state)) {
          throw conflict(
            'eta_document_live',
            `This invoice already has an ETA document that is ${live.state}.`,
          );
        }
        const open = await tx.eta.openSigningRequestFor(live.id);
        if (open !== undefined) {
          await tx.eta.finishSigningRequest(open.id, 'cancelled', new Date(), 'superseded');
        }
        const superseded = await tx.eta.transition(live.id, [live.state], 'superseded');
        if (superseded === undefined) {
          throw stateConflict(live, 'unchanged');
        }
      }
      const { document, computed } = buildInvoiceDocument(input);
      const text = writeJsonText(document);
      const digest = toHex(await canonicalDigest(document));
      const id = randomUUID();
      const created = await tx.eta.createDocument({
        id,
        invoiceId: params.invoiceId,
        environment: settings.environment,
        internalId: input.invoice.internalId,
        unsignedJson: text,
        canonicalSha256: digest,
        exchangeRate: input.invoice.exchangeRate,
        totalAmount: formatDecimal(computed.totalAmount),
        currencyCode: input.invoice.currencyCode,
        by: principal.userId,
      });
      await audit(tx, context, 'eta.document_prepared', 'eta_document', id, {
        invoiceId: params.invoiceId,
        sequence: created.sequence,
        environment: created.environment,
        supersededId: live?.id ?? null,
      });
      return created;
    });
    return { status: 201, body: documentView(prepared) };
  },
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const listEtaDocumentsRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/documents',
  operationId: 'listEtaDocuments',
  summary: 'ETA documents, newest first',
  description: '`state` may be repeated as a comma-separated list. A page at a time with `cursor`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    state: z
      .string()
      .optional()
      .transform((value) => (value === undefined || value === '' ? [] : value.split(',')))
      .pipe(z.array(z.enum(ETA_DOCUMENT_STATES))),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(200).optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({ items: z.array(documentSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    let before: { preparedAt: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      const [at, id] = Buffer.from(query.cursor, 'base64url').toString('utf8').split('|');
      const preparedAt = new Date(at ?? '');
      if (
        id === undefined ||
        Number.isNaN(preparedAt.getTime()) ||
        !z.uuid().safeParse(id).success
      ) {
        throw unprocessable('invalid_cursor', 'That cursor is not one this list gave out.');
      }
      before = { preparedAt, id };
    }
    const items = await withTenant(context.principal.tenantId, (tx) =>
      tx.eta.listDocuments({
        states: query.state,
        limit: query.limit + 1,
        ...(before === undefined ? {} : { before }),
      }),
    );
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return {
      status: 200,
      body: {
        items: page.map(documentView),
        nextCursor:
          items.length > query.limit && last !== undefined
            ? Buffer.from(`${last.preparedAt.toISOString()}|${last.id}`, 'utf8').toString(
                'base64url',
              )
            : null,
      },
    };
  },
});

export const getEtaDocumentRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/documents/:documentId',
  operationId: 'getEtaDocument',
  summary: 'One ETA document, with its signing request and every call made about it',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: detailSchema },
    404: { description: 'No such document.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) =>
      detail(tx, await documentOrNotFound(tx, params.documentId)),
    );
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export const requestEtaSignatureRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/documents/:documentId/signature-request',
  operationId: 'requestEtaSignature',
  summary: 'Ask the signing agent to sign a ready document',
  description:
    'Records a request bound to the document’s canonical digest, with a random nonce and an expiry (ETA_SIGNING_REQUEST_TTL_SECONDS). The company’s signing agent — its desktop app, on the computer that holds the token — picks it up. 422 `eta_no_certificates` until a certificate is pinned.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.submit',
  feature: FEATURE,
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    201: { description: 'The document, awaiting its signature.', schema: detailSchema },
    404: { description: 'No such document.' },
    409: { description: 'Not ready.' },
    422: { description: 'No certificate pinned.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await tx.eta.settings();
      if (!settings.enabled) {
        refuseProblem('eta_disabled');
      }
      if (settings.pinnedCertificates.length === 0) {
        throw unprocessable(
          'eta_no_certificates',
          'Choose the certificate allowed to sign in the e-invoicing settings first.',
        );
      }
      const document = await documentOrNotFound(tx, params.documentId);
      const moved = await tx.eta.transition(document.id, ['ready'], 'pending_signature');
      if (moved === undefined) {
        throw stateConflict(document, 'ready');
      }
      const now = new Date();
      const request = await tx.eta.createSigningRequest({
        id: randomUUID(),
        documentId: document.id,
        digest: document.canonicalSha256,
        nonce: randomBytes(32).toString('hex'),
        expiresAt: new Date(now.getTime() + context.config.ETA_SIGNING_REQUEST_TTL_SECONDS * 1000),
        by: principal.userId,
      });
      await audit(tx, context, 'eta.signature_requested', 'eta_document', document.id, {
        signingRequestId: request.id,
      });
      return detail(tx, moved);
    });
    return { status: 201, body };
  },
});

export const cancelEtaSignatureRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/signing-requests/:requestId/cancel',
  operationId: 'cancelEtaSignature',
  summary: 'Withdraw a signing request; the document is ready again',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['eta.submit', 'eta.sign'],
  feature: FEATURE,
  params: z.object({ requestId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: detailSchema },
    404: { description: 'No such request.' },
    409: { description: 'Already finished.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const request = await tx.eta.signingRequest(params.requestId);
      if (request === undefined) {
        throw notFound('No such signing request.');
      }
      const finished = await tx.eta.finishSigningRequest(
        request.id,
        'cancelled',
        new Date(),
        'withdrawn',
      );
      if (finished === undefined) {
        throw conflict('eta_request_closed', 'That signing request is already finished.');
      }
      const document = await tx.eta.transition(request.documentId, ['pending_signature'], 'ready');
      await audit(tx, context, 'eta.signature_withdrawn', 'eta_document', request.documentId, {
        signingRequestId: request.id,
      });
      return detail(tx, document ?? (await documentOrNotFound(tx, request.documentId)));
    });
    return { status: 200, body };
  },
});

export const etaSigningQueueRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/signing-requests',
  operationId: 'listEtaSigningRequests',
  summary: 'The signing agent’s queue',
  description:
    'Open and claimed requests of this company, oldest first. Expired ones are closed first and their documents made ready again.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.sign',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The queue.', schema: z.object({ items: z.array(signingRequestSchema) }) },
  },
  handler: async (_input, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const requests = await tx.eta.signingQueue(new Date());
      const views = [];
      for (const request of requests) {
        const document = await tx.eta.document(request.documentId);
        if (document !== undefined) {
          views.push(requestView(request, document, false));
        }
      }
      return views;
    });
    return { status: 200, body: { items } };
  },
});

export const claimEtaSigningRequestRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/signing-requests/:requestId/claim',
  operationId: 'claimEtaSigningRequest',
  summary: 'The signing agent takes a request and the exact document text to sign',
  description:
    '`documentText` is the unsigned document exactly as stored. The agent recomputes its canonical digest, refuses a mismatch, and shows the person what it reads from the text itself. Integr8 staff acting as the company are refused.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.sign',
  feature: FEATURE,
  params: z.object({ requestId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The request and the document text.',
      schema: z.object({ request: signingRequestSchema, documentText: z.string() }),
    },
    404: { description: 'No such request.' },
    409: { description: 'Expired, finished or claimed by someone else.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'sign documents');
    const body = await withTenant(principal.tenantId, async (tx) => {
      const existing = await tx.eta.signingRequest(params.requestId);
      if (existing === undefined) {
        throw notFound('No such signing request.');
      }
      const claimed = await tx.eta.claimSigningRequest(existing.id, principal.userId, new Date());
      if (claimed === undefined) {
        throw conflict(
          'eta_request_unavailable',
          'That signing request has expired, finished, or is being signed elsewhere.',
        );
      }
      const document = await documentOrNotFound(tx, claimed.documentId);
      const texts = await tx.eta.documentTexts(document.id);
      await audit(tx, context, 'eta.signature_claimed', 'eta_document', document.id, {
        signingRequestId: claimed.id,
      });
      return {
        request: requestView(claimed, document, true),
        documentText: texts?.unsigned ?? '',
      };
    });
    return { status: 200, body };
  },
});

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** How far a signature's signing time may sit outside the request's life: clocks differ. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export const completeEtaSigningRequestRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/signing-requests/:requestId/complete',
  operationId: 'completeEtaSigningRequest',
  summary: 'The signing agent returns the signature',
  description:
    'Accepted only from the member who claimed the request, before it expires, with its nonce, for a CMS (CAdES-BES, detached, Base64) that verifies against the stored digest and a certificate the company pinned, signed within the request’s life. Anything else is refused (422 `eta_signature_refused`, the reason as a detail) and the document returns to ready.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.sign',
  feature: FEATURE,
  params: z.object({ requestId: z.uuid() }),
  query: noSchema,
  body: z.object({
    nonce: z.string().min(16).max(200),
    cms: z
      .string()
      .min(100)
      .max(200_000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'Base64'),
  }),
  responses: {
    200: { description: 'The document, signed.', schema: detailSchema },
    404: { description: 'No such request.' },
    409: { description: 'Not claimed by this member, expired, or finished.' },
    422: { description: 'The signature was refused.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'sign documents');
    const now = new Date();
    const loaded = await withTenant(principal.tenantId, async (tx) => {
      const request = await tx.eta.signingRequest(params.requestId);
      if (request === undefined) {
        throw notFound('No such signing request.');
      }
      if (
        request.status !== 'claimed' ||
        request.claimedBy !== principal.userId ||
        request.expiresAt.getTime() <= now.getTime()
      ) {
        throw conflict(
          'eta_request_unavailable',
          'That signing request has expired, finished, or was claimed by someone else.',
        );
      }
      if (!sameText(request.nonce, body.nonce)) {
        throw forbidden('That answer does not belong to this signing request.');
      }
      const document = await documentOrNotFound(tx, request.documentId);
      const texts = await tx.eta.documentTexts(document.id);
      const settings = await tx.eta.settings();
      return {
        request,
        document,
        unsigned: texts?.unsigned ?? '',
        pins: settings.pinnedCertificates,
      };
    });
    const { request, document, unsigned } = loaded;

    // The digest is recomputed from the stored text, not taken from the row.
    const parsed = parseJsonText(unsigned);
    const digest = await canonicalDigest(parsed);
    let refusal: string | null = null;
    let signerSha256 = '';
    if (toHex(digest) !== request.digest || request.digest !== document.canonicalSha256) {
      refusal = 'digest_mismatch';
    } else {
      try {
        const verified = await verifyCadesBes({
          cms: fromBase64(body.cms),
          digest: fromHex(request.digest),
          pinnedCertificates: loaded.pins,
          notBefore: new Date(request.requestedAt.getTime() - CLOCK_SKEW_MS),
          notAfter: new Date(now.getTime() + CLOCK_SKEW_MS),
        });
        signerSha256 = verified.certificate.sha256;
      } catch (error) {
        if (!(error instanceof CmsVerificationError)) {
          throw error;
        }
        refusal = error.reason;
      }
    }

    const result = await withTenant(principal.tenantId, async (tx) => {
      if (refusal !== null) {
        const closed = await tx.eta.finishSigningRequest(request.id, 'cancelled', now, refusal);
        if (closed !== undefined) {
          await tx.eta.transition(document.id, ['pending_signature'], 'ready', {
            lastErrorCode: 'eta_signature_refused',
          });
        }
        await audit(tx, context, 'eta.signature_refused', 'eta_document', document.id, {
          signingRequestId: request.id,
          reason: refusal,
        });
        return { refused: refusal } as const;
      }
      const signedText = writeJsonText(withSignature(parsed, toBase64(fromBase64(body.cms))));
      const finished = await tx.eta.finishSigningRequest(request.id, 'completed', now);
      if (finished === undefined) {
        throw conflict('eta_request_unavailable', 'That signing request was closed meanwhile.');
      }
      const signed = await tx.eta.transition(document.id, ['pending_signature'], 'signed', {
        signed: { json: signedText, certificate: signerSha256, by: principal.userId, at: now },
        lastErrorCode: null,
      });
      if (signed === undefined) {
        throw stateConflict(document, 'awaiting its signature');
      }
      await audit(tx, context, 'eta.document_signed', 'eta_document', document.id, {
        signingRequestId: request.id,
        certificate: signerSha256,
      });
      return { detail: await detail(tx, signed) } as const;
    });
    if ('refused' in result) {
      throw unprocessable('eta_signature_refused', 'The signature was refused.', [
        { field: 'body.cms', code: `eta_signature_${result.refused}`, message: result.refused },
      ]);
    }
    return { status: 200, body: result.detail };
  },
});

// ---------------------------------------------------------------------------
// Submission and after
// ---------------------------------------------------------------------------

export const submitEtaDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/documents/:documentId/submit',
  operationId: 'submitEtaDocument',
  summary: 'Send a signed document to the ETA',
  description:
    'Only a signed document (or one whose last attempt definitely failed), in the environment it was prepared for, that validates against the company’s fetched schema (422 `eta_schema_missing`, `eta_schema_invalid`) and whose amounts add up (422 `eta_arithmetic`). Queued, sent once, never retried blindly: an answer that is lost makes the document `unknown` for a person to resolve. A 202 from the ETA is not validity; the status is checked afterwards. Requires `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.submit',
  feature: FEATURE,
  idempotent: 'required',
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    202: { description: 'Queued.', schema: detailSchema },
    404: { description: 'No such document.' },
    409: { description: 'Not signed, or the environment changed.' },
    422: { description: 'No schema, or the document does not pass it.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await tx.eta.settings();
      const opened = openEtaClient(
        { config: context.config, eta: context.services.eta },
        principal.tenantId,
        settings,
        await tx.eta.sealedCredentials(),
      );
      if ('problem' in opened) {
        refuseProblem(opened.problem);
      }
      const document = await documentOrNotFound(tx, params.documentId);
      if (document.environment !== settings.environment) {
        throw conflict(
          'eta_environment_changed',
          `This document was prepared for ${document.environment}; prepare the invoice again for ${settings.environment}.`,
        );
      }
      if (!['signed', 'failed'].includes(document.state)) {
        throw stateConflict(document, 'signed');
      }
      const texts = await tx.eta.documentTexts(document.id);
      if (texts?.signed === null || texts === undefined) {
        throw conflict('eta_document_unsigned', 'An unsigned document is never sent.');
      }
      const schema = await tx.eta.schema(
        document.environment,
        ETA_DOCUMENT_TYPE_INVOICE,
        settings.documentTypeVersion,
      );
      if (schema === undefined) {
        throw unprocessable(
          'eta_schema_missing',
          'Fetch the ETA’s invoice schema for this environment in the e-invoicing settings first.',
        );
      }
      const schemaIssues = compileSchema(schema.schemaText).validate(texts.signed);
      if (schemaIssues.length > 0) {
        throw unprocessable(
          'eta_schema_invalid',
          'The document does not pass the ETA’s schema.',
          schemaIssues.slice(0, 50).map((issue) => ({
            field: issue.path,
            code: `schema_${issue.keyword}`,
            message: issue.message,
          })),
        );
      }
      const arithmetic = checkDocumentArithmetic(parseJsonText(texts.signed));
      if (arithmetic.length > 0) {
        throw unprocessable(
          'eta_arithmetic',
          'The document’s amounts do not add up.',
          arithmetic.slice(0, 50).map((issue) => ({
            field: issue.path,
            code: 'eta_arithmetic',
            message: `Expected ${issue.expected}, found ${issue.actual}.`,
            params: { expected: issue.expected, actual: issue.actual },
          })),
        );
      }
      if (document.state === 'failed') {
        const again = await tx.eta.transition(document.id, ['failed'], 'signed');
        if (again === undefined) {
          throw stateConflict(document, 'signed');
        }
      }
      const moved = await tx.eta.transition(document.id, ['signed'], 'submitting', {
        submittedBy: principal.userId,
        lastErrorCode: null,
      });
      if (moved === undefined) {
        throw stateConflict(document, 'signed');
      }
      await tx.jobs.enqueue({
        queue: ETA_SUBMIT_QUEUE,
        payload: { documentId: document.id, actorId: principal.userId },
        maxAttempts: ETA_SUBMIT_ATTEMPTS,
      });
      await audit(tx, context, 'eta.document_submitted', 'eta_document', document.id, {
        environment: document.environment,
      });
      return detail(tx, moved);
    });
    return { status: 202, body };
  },
});

export const syncEtaDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/documents/:documentId/sync',
  operationId: 'syncEtaDocument',
  summary: 'Ask the ETA for a submitted or valid document’s status now',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.submit',
  feature: FEATURE,
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: detailSchema },
    404: { description: 'No such document.' },
    409: { description: 'Not submitted.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const document = await documentOrNotFound(tx, params.documentId);
      if (!['submitted', 'valid'].includes(document.state) || document.etaUuid === null) {
        throw stateConflict(document, 'submitted or valid');
      }
      const opened = openEtaClient(
        { config: context.config, eta: context.services.eta },
        principal.tenantId,
        await tx.eta.settings(),
        await tx.eta.sealedCredentials(),
        { requireEnabled: false },
      );
      if ('problem' in opened) {
        refuseProblem(opened.problem);
      }
      const outcome = await checkStatus(tx, opened.client, document, {
        // A person asking does not use up the background checks.
        maxChecks: Number.MAX_SAFE_INTEGER,
        actorId: principal.userId,
      });
      return detail(tx, outcome.document);
    });
    return { status: 200, body };
  },
});

export const resolveEtaDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/documents/:documentId/resolve',
  operationId: 'resolveEtaDocument',
  summary: 'Say what happened to a document whose submission had no clear answer',
  description:
    'For a document in `unknown`. Look it up in the ETA portal first. `received` with the ETA’s `etaUuid` makes it submitted and checks its status; `not_received` makes it signed so it can be sent again — sending a document the ETA did receive creates a duplicate, so say this only when the portal shows nothing.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.submit',
  feature: FEATURE,
  params: documentParams,
  query: noSchema,
  body: z.discriminatedUnion('outcome', [
    z.object({
      outcome: z.literal('received'),
      etaUuid: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9-]{10,100}$/u, 'The ETA’s document UUID'),
    }),
    z.object({ outcome: z.literal('not_received') }),
  ]),
  responses: {
    200: { description: 'The document.', schema: detailSchema },
    404: { description: 'No such document.' },
    409: { description: 'Not unknown.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'resolve a submission');
    const result = await withTenant(principal.tenantId, async (tx) => {
      const document = await documentOrNotFound(tx, params.documentId);
      const now = new Date();
      const moved =
        body.outcome === 'received'
          ? await tx.eta.transition(document.id, ['unknown'], 'submitted', {
              etaUuid: body.etaUuid,
              submittedAt: document.submittedAt ?? now,
              checks: 0,
              nextCheckAt: now,
              lastErrorCode: null,
            })
          : await tx.eta.transition(document.id, ['unknown'], 'signed', { lastErrorCode: null });
      if (moved === undefined) {
        throw stateConflict(document, 'unknown');
      }
      if (body.outcome === 'received') {
        await tx.jobs.enqueue({
          queue: ETA_RECONCILE_QUEUE,
          payload: { documentId: document.id },
          maxAttempts: 3,
        });
      }
      await audit(tx, context, 'eta.document_resolved', 'eta_document', document.id, {
        outcome: body.outcome,
      });
      return detail(tx, moved);
    });
    return { status: 200, body: result };
  },
});

export const cancelEtaDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/documents/:documentId/cancel',
  operationId: 'cancelEtaDocument',
  summary: 'Ask the ETA to cancel a valid document',
  description:
    'Sent once; the document stays valid until the ETA reports it cancelled, which is then checked in the background. The invoice is not changed: issue a credit note or void it in Integr8 as well. Requires `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.submit',
  feature: FEATURE,
  idempotent: 'required',
  params: documentParams,
  query: noSchema,
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  responses: {
    200: { description: 'The document.', schema: detailSchema },
    404: { description: 'No such document.' },
    409: { description: 'Not valid.' },
    502: { description: 'The ETA refused or could not be reached.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'cancel a document');
    const { document, opened } = await withTenant(principal.tenantId, async (tx) => {
      const found = await documentOrNotFound(tx, params.documentId);
      if (found.state !== 'valid' || found.etaUuid === null) {
        throw stateConflict(found, 'valid');
      }
      return {
        document: found,
        opened: openEtaClient(
          { config: context.config, eta: context.services.eta },
          principal.tenantId,
          await tx.eta.settings(),
          await tx.eta.sealedCredentials(),
        ),
      };
    });
    if ('problem' in opened) {
      refuseProblem(opened.problem);
    }
    const startedAt = new Date();
    let failure: EtaApiError | null = null;
    let correlationId: string | null = null;
    try {
      ({ correlationId } = await opened.client.cancel(document.etaUuid!, body.reason));
    } catch (error) {
      if (!(error instanceof EtaApiError)) {
        throw error;
      }
      failure = error;
    }
    const result = await withTenant(principal.tenantId, async (tx) => {
      await tx.eta.recordAttempt({
        documentId: document.id,
        kind: 'cancel',
        outcome: failure === null ? 'ok' : failure.ambiguous ? 'unknown' : 'error',
        httpStatus: failure?.status ?? 200,
        errorCode: failure === null ? null : (failure.code ?? failure.kind),
        correlationId: failure?.correlationId ?? correlationId,
        startedAt,
        actorId: principal.userId,
      });
      if (failure !== null) {
        return null;
      }
      const watched = await tx.eta.transition(document.id, ['valid'], 'valid', {
        checks: 0,
        nextCheckAt: new Date(Date.now() + 15_000),
      });
      await tx.jobs.enqueue({
        queue: ETA_RECONCILE_QUEUE,
        payload: { documentId: document.id, watchCancellation: true },
        availableAt: new Date(Date.now() + 15_000),
        maxAttempts: 3,
      });
      await audit(tx, context, 'eta.cancel_requested', 'eta_document', document.id);
      return detail(tx, watched ?? document);
    });
    if (failure !== null) {
      throw etaFailure(failure);
    }
    return { status: 200, body: result! };
  },
});

export const etaDocumentPdfRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/documents/:documentId/pdf',
  operationId: 'getEtaDocumentPdf',
  summary: 'The ETA’s printable copy of an accepted document, as Base64',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The PDF.',
      schema: z.object({
        fileName: z.string(),
        contentType: z.literal('application/pdf'),
        base64: z.string(),
      }),
    },
    404: { description: 'No such document.' },
    409: { description: 'Not accepted by the ETA.' },
    502: { description: 'The ETA refused or could not be reached.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const { document, opened } = await withTenant(principal.tenantId, async (tx) => {
      const found = await documentOrNotFound(tx, params.documentId);
      if (
        !['submitted', 'valid', 'invalid', 'cancelled'].includes(found.state) ||
        found.etaUuid === null
      ) {
        throw stateConflict(found, 'accepted by the ETA');
      }
      return {
        document: found,
        opened: openEtaClient(
          { config: context.config, eta: context.services.eta },
          principal.tenantId,
          await tx.eta.settings(),
          await tx.eta.sealedCredentials(),
          { requireEnabled: false },
        ),
      };
    });
    if ('problem' in opened) {
      refuseProblem(opened.problem);
    }
    try {
      const pdf = await opened.client.documentPdf(document.etaUuid!);
      return {
        status: 200,
        body: {
          fileName: `${document.internalId}-ETA.pdf`,
          contentType: 'application/pdf' as const,
          base64: Buffer.from(pdf).toString('base64'),
        },
      };
    } catch (error) {
      if (error instanceof EtaApiError) {
        throw etaFailure(error);
      }
      throw error;
    }
  },
});

export const etaDocumentRoutes = [
  etaInvoiceRoute,
  prepareEtaDocumentRoute,
  listEtaDocumentsRoute,
  getEtaDocumentRoute,
  requestEtaSignatureRoute,
  cancelEtaSignatureRoute,
  etaSigningQueueRoute,
  claimEtaSigningRequestRoute,
  completeEtaSigningRequestRoute,
  submitEtaDocumentRoute,
  syncEtaDocumentRoute,
  resolveEtaDocumentRoute,
  cancelEtaDocumentRoute,
  etaDocumentPdfRoute,
];
