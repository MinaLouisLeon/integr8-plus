import {
  ETA_DOCUMENT_STATES,
  ETA_ENVIRONMENTS,
  ETA_ITEM_TYPES,
  ETA_RECEIVER_TYPES,
  type Principal,
} from '@integr8/core';
import type { EtaAddress, EtaDocumentRecord, EtaSettings } from '@integr8/db';
import { z } from 'zod';
import { ApiError, forbidden, unprocessable } from '../../http/errors.js';
import type { RequestContext } from '../../http/routes.js';
import type { EtaClientProblem } from '../../eta/services.js';
import { isoOrNull } from './schemas.js';

/**
 * What the e-invoicing routes share (ADR-0014): the tag and module, the
 * views, and the refusals every route words the same way.
 */

export const TAGS = ['e-invoicing'];
export const FEATURE = 'e_invoicing' as const;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** A free-text field the ETA document carries. Quotes and backslashes are refused (SPEC-UNVERIFIED canonical-escapes). */
export const etaText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (value) => !/["\\\p{Cc}]/u.test(value),
      'Quotes, backslashes and control characters are not supported',
    );

const optionalText = (max: number) => etaText(max).nullable();

/** An ETA code typed from the ETA's code tables: letters, digits, dot, dash, underscore. */
export const etaCode = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._-]+$/u, 'Letters, digits, dots, dashes and underscores');

export const addressSchema = z.object({
  country: etaCode(2).nullable(),
  governate: optionalText(100),
  regionCity: optionalText(100),
  street: optionalText(200),
  buildingNumber: optionalText(100),
  postalCode: optionalText(30),
  floor: optionalText(100),
  room: optionalText(100),
  landmark: optionalText(500),
  additionalInformation: optionalText(500),
});

export const emptyAddress: EtaAddress = {
  country: null,
  governate: null,
  regionCity: null,
  street: null,
  buildingNumber: null,
  postalCode: null,
  floor: null,
  room: null,
  landmark: null,
  additionalInformation: null,
};

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const settingsSchema = z.object({
  enabled: z.boolean(),
  environment: z.enum(ETA_ENVIRONMENTS),
  issuerType: z.string(),
  taxpayerId: z.string().nullable(),
  issuerName: z.string().nullable(),
  branchId: z.string().nullable(),
  activityCode: z.string().nullable(),
  address: addressSchema,
  credentials: z.object({
    saved: z.boolean(),
    /** The client id's last four characters. The secret is never shown. */
    hint: z.string().nullable(),
    updatedAt: z.iso.datetime().nullable(),
  }),
  intermediaryFor: z.string().nullable(),
  documentTypeVersion: z.string(),
  defaultItem: z.object({ itemType: z.enum(ETA_ITEM_TYPES), itemCode: z.string() }).nullable(),
  /** SHA-256 of each certificate allowed to sign, lower-case hex. */
  pinnedCertificates: z.array(z.string()),
  version: z.number().int(),
  updatedAt: z.iso.datetime().nullable(),
  server: z.object({
    /** Whether ETA_CREDENTIALS_KEY is set: credentials can be saved and used. */
    credentialsKeyConfigured: z.boolean(),
    /** Whether this deployment lets a company choose production. */
    productionAllowed: z.boolean(),
  }),
});

export function settingsView(context: RequestContext, settings: EtaSettings) {
  return {
    enabled: settings.enabled,
    environment: settings.environment,
    issuerType: settings.issuerType,
    taxpayerId: settings.taxpayerId,
    issuerName: settings.issuerName,
    branchId: settings.branchId,
    activityCode: settings.activityCode,
    address: settings.address,
    credentials: {
      saved: settings.hasCredentials,
      hint: settings.credentialsHint,
      updatedAt: isoOrNull(settings.credentialsUpdatedAt),
    },
    intermediaryFor: settings.intermediaryFor,
    documentTypeVersion: settings.documentTypeVersion,
    defaultItem: settings.defaultItem,
    pinnedCertificates: settings.pinnedCertificates,
    version: settings.version,
    updatedAt: isoOrNull(settings.updatedAt),
    server: {
      credentialsKeyConfigured: context.config.ETA_CREDENTIALS_KEY !== undefined,
      productionAllowed: context.config.ETA_ALLOW_PRODUCTION,
    },
  };
}

export const storedErrorSchema = z.object({
  code: z.string().nullable(),
  message: z.string(),
  target: z.string().nullable(),
});

export const documentSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  sequence: z.number().int(),
  environment: z.enum(ETA_ENVIRONMENTS),
  internalId: z.string(),
  state: z.enum(ETA_DOCUMENT_STATES),
  /** As the ETA last spelled it. */
  etaStatus: z.string().nullable(),
  etaUuid: z.string().nullable(),
  etaLongId: z.string().nullable(),
  submissionId: z.string().nullable(),
  totalAmount: z.string(),
  currencyCode: z.string(),
  exchangeRate: z.string().nullable(),
  canonicalSha256: z.string(),
  signerCertificate: z.string().nullable(),
  signedAt: z.iso.datetime().nullable(),
  preparedAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  finalAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  checks: z.number().int(),
  lastErrorCode: z.string().nullable(),
  errors: z.array(storedErrorSchema),
  version: z.number().int(),
});

function errorsOf(value: unknown[]): z.infer<typeof storedErrorSchema>[] {
  return value.flatMap((entry) => {
    const parsed = storedErrorSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export function documentView(document: EtaDocumentRecord): z.infer<typeof documentSchema> {
  return {
    id: document.id,
    invoiceId: document.invoiceId,
    sequence: document.sequence,
    environment: document.environment,
    internalId: document.internalId,
    state: document.state,
    etaStatus: document.etaStatus,
    etaUuid: document.etaUuid,
    etaLongId: document.etaLongId,
    submissionId: document.submissionId,
    totalAmount: document.totalAmount,
    currencyCode: document.currencyCode,
    exchangeRate: document.exchangeRate,
    canonicalSha256: document.canonicalSha256,
    signerCertificate: document.signerCertificate,
    signedAt: isoOrNull(document.signedAt),
    preparedAt: document.preparedAt.toISOString(),
    submittedAt: isoOrNull(document.submittedAt),
    finalAt: isoOrNull(document.finalAt),
    nextCheckAt: isoOrNull(document.nextCheckAt),
    checks: document.checks,
    lastErrorCode: document.lastErrorCode,
    errors: errorsOf(document.errors),
    version: document.version,
  };
}

export const receiverSchema = z.object({
  customerId: z.uuid(),
  receiverType: z.enum(ETA_RECEIVER_TYPES),
  receiverId: z.string().nullable(),
  address: addressSchema,
  updatedAt: z.iso.datetime(),
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const PROBLEMS: Record<EtaClientProblem, () => ApiError> = {
  eta_disabled: () =>
    new ApiError(409, 'eta_disabled', 'E-invoicing is switched off in this company’s settings.'),
  eta_key_missing: () =>
    new ApiError(
      503,
      'eta_key_missing',
      'ETA credentials cannot be stored or used until ETA_CREDENTIALS_KEY is set on the server.',
    ),
  eta_credentials_missing: () =>
    new ApiError(
      409,
      'eta_credentials_missing',
      'Save the company’s ETA client id and secret in the e-invoicing settings first.',
    ),
  eta_credentials_unreadable: () =>
    new ApiError(
      409,
      'eta_credentials_unreadable',
      'The saved ETA credentials cannot be opened with this server’s key. Enter them again.',
    ),
  eta_production_disabled: () =>
    forbidden('The ETA production environment is not enabled on this server.', [
      {
        field: 'environment',
        code: 'eta_production_disabled',
        message: 'Production is off for this deployment.',
      },
    ]),
};

export function refuseProblem(problem: EtaClientProblem): never {
  throw PROBLEMS[problem]();
}

export function keyOrRefuse(context: RequestContext): string {
  const value = context.config.ETA_CREDENTIALS_KEY;
  if (value === undefined) {
    refuseProblem('eta_key_missing');
  }
  return value;
}

/** Changes on the company's behalf by Integr8 staff are not allowed for these. */
export function refuseImpersonation(principal: Principal, what: string): void {
  if (principal.impersonatedBy !== undefined) {
    throw forbidden(`Integr8 staff cannot ${what} for a company.`, [
      {
        field: 'principal',
        code: 'eta_staff_refused',
        message: 'Sign in as the company’s own member.',
      },
    ]);
  }
}

export const notReady = (
  details: { field: string; code: string; message: string; params?: Record<string, string> }[],
) => unprocessable('eta_not_ready', 'The invoice is not ready to become an ETA document.', details);
