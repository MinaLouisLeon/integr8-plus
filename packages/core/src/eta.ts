import { z } from 'zod';

/**
 * The vocabulary of Egyptian e-invoicing (ADR-0014), shared by the database's
 * check constraints, the API and every screen. The schema-invariant suite
 * compares these lists with the constraints of migration 0049.
 */

/** Where a company sends documents. A company chooses; the URLs are the server's. */
export const ETA_ENVIRONMENTS = ['preprod', 'production'] as const;
export const etaEnvironmentSchema = z.enum(ETA_ENVIRONMENTS);
export type EtaEnvironment = z.infer<typeof etaEnvironmentSchema>;

/** A document's life (docs/e-invoicing PLAN §3). The invoice it came from never moves. */
export const ETA_DOCUMENT_STATES = [
  'ready',
  'pending_signature',
  'signed',
  'submitting',
  'submitted',
  'valid',
  'invalid',
  'rejected',
  'cancelled',
  'failed',
  'unknown',
  'superseded',
] as const;
export const etaDocumentStateSchema = z.enum(ETA_DOCUMENT_STATES);
export type EtaDocumentState = z.infer<typeof etaDocumentStateSchema>;

/** What an ETA document was made from. Credit and debit notes are a later extension. */
export const ETA_DOCUMENT_KINDS = ['invoice'] as const;
export const etaDocumentKindSchema = z.enum(ETA_DOCUMENT_KINDS);
export type EtaDocumentKind = z.infer<typeof etaDocumentKindSchema>;

/** Receiver types: business, person, foreigner (SPEC-UNVERIFIED receiver-rules). */
export const ETA_RECEIVER_TYPES = ['B', 'P', 'F'] as const;
export const etaReceiverTypeSchema = z.enum(ETA_RECEIVER_TYPES);
export type EtaReceiverType = z.infer<typeof etaReceiverTypeSchema>;

/** Item code systems. */
export const ETA_ITEM_TYPES = ['GS1', 'EGS'] as const;
export const etaItemTypeSchema = z.enum(ETA_ITEM_TYPES);
export type EtaItemType = z.infer<typeof etaItemTypeSchema>;

/** What one call to the tax authority was for. */
export const ETA_ATTEMPT_KINDS = ['token', 'submit', 'status', 'cancel', 'pdf', 'schema'] as const;
export const etaAttemptKindSchema = z.enum(ETA_ATTEMPT_KINDS);
export type EtaAttemptKind = z.infer<typeof etaAttemptKindSchema>;

/** How one call ended. `unknown`: no answer, so nobody knows whether it arrived. */
export const ETA_ATTEMPT_OUTCOMES = ['ok', 'accepted', 'rejected', 'error', 'unknown'] as const;
export const etaAttemptOutcomeSchema = z.enum(ETA_ATTEMPT_OUTCOMES);
export type EtaAttemptOutcome = z.infer<typeof etaAttemptOutcomeSchema>;

/** A signing request's life. */
export const ETA_SIGNING_STATUSES = [
  'open',
  'claimed',
  'completed',
  'cancelled',
  'expired',
] as const;
export const etaSigningStatusSchema = z.enum(ETA_SIGNING_STATUSES);
export type EtaSigningStatus = z.infer<typeof etaSigningStatusSchema>;

/** The units an invoice line may have (migration 0030), each mapped by the company to an ETA unit type. */
export const ETA_MAPPABLE_UNITS = [
  'each',
  'pair',
  'set',
  'box',
  'pack',
  'roll',
  'm',
  'm2',
  'm3',
  'l',
  'kg',
  'g',
  'hour',
] as const;
export type EtaMappableUnit = (typeof ETA_MAPPABLE_UNITS)[number];

/** A code from an ETA code table, as a company types it: printable, no quotes or backslashes. */
export const etaCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^"\\\p{Cc}]+$/u, 'Letters, digits and ordinary punctuation only');

/** States a document can still move out of on its own (polling, the worker). */
export function isEtaDocumentOpen(state: EtaDocumentState): boolean {
  return state === 'submitting' || state === 'submitted';
}
