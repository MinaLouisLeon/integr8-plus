import type { EtaDocumentState } from '@integr8/core';
import type {
  EtaDocumentRecord,
  EtaSettings,
  EtaAddress as StoredAddress,
  TenantTransaction,
} from '@integr8/db';
import type {
  EtaAddress,
  EtaBuildInput,
  EtaInvoiceLine,
  EtaMappings,
  EtaReceiverProfile,
} from '@integr8/eta';
import { EtaApiError, type EtaClient, type EtaErrorDetail } from '@integr8/eta/node';

/**
 * The parts of the e-invoicing lifecycle shared by the routes and the worker
 * (docs/e-invoicing PLAN §3): reading an invoice into the builder's input,
 * the outcome of a submission, and the reading of a status.
 */

export const ETA_SUBMIT_QUEUE = 'eta.submit';
export const ETA_RECONCILE_QUEUE = 'eta.reconcile';

/** Seconds before the first status check; doubles after each, to an hour. */
const FIRST_CHECK_SECONDS = 15;
const LONGEST_CHECK_SECONDS = 3600;

export function nextCheckDelayMs(checks: number): number {
  return Math.min(FIRST_CHECK_SECONDS * 2 ** checks, LONGEST_CHECK_SECONDS) * 1000;
}

function present(address: StoredAddress): boolean {
  return Object.values<string | null>({ ...address }).some(
    (value) => value !== null && value.trim() !== '',
  );
}

function builderAddress(address: StoredAddress): EtaAddress {
  return {
    country: address.country ?? '',
    governate: address.governate ?? '',
    regionCity: address.regionCity ?? '',
    street: address.street ?? '',
    buildingNumber: address.buildingNumber ?? '',
    postalCode: address.postalCode,
    floor: address.floor,
    room: address.room,
    landmark: address.landmark,
    additionalInformation: address.additionalInformation,
  };
}

/**
 * Everything the builder needs for one invoice, read in the caller's
 * transaction. Undefined when the invoice does not exist in this company.
 */
export async function readBuildInput(
  tx: TenantTransaction,
  settings: EtaSettings,
  invoiceId: string,
  exchangeRate: string | null,
  internalId: (reference: number) => string,
): Promise<EtaBuildInput | undefined> {
  const invoice = await tx.financeInvoices.findInvoice(invoiceId);
  if (invoice === undefined) {
    return undefined;
  }
  const [lines, totals, receiver, unitTypes, taxes] = await Promise.all([
    tx.financeInvoices.invoiceLines(invoiceId),
    tx.financeInvoices.invoiceTotals(invoiceId),
    tx.eta.receiver(invoice.customerId),
    tx.eta.unitTypes(),
    tx.eta.taxMappings(),
  ]);
  const itemIds = lines.flatMap((line) => (line.itemId === null ? [] : [line.itemId]));
  const [items, itemCodes] = await Promise.all([
    tx.inventoryCatalogue.findItems(itemIds),
    tx.eta.itemCodes(itemIds),
  ]);
  const sku = new Map(items.map((item) => [item.id, item.sku]));
  const codes = new Map(itemCodes.map((code) => [code.itemId, code]));

  const issuer =
    settings.taxpayerId === null && settings.issuerName === null
      ? null
      : {
          type: settings.issuerType,
          id: settings.taxpayerId ?? '',
          name: settings.issuerName ?? '',
          branchId: settings.branchId ?? '',
          activityCode: settings.activityCode ?? '',
          address: builderAddress(settings.address),
        };

  const receiverProfile: EtaReceiverProfile | null =
    receiver === undefined
      ? null
      : {
          type: receiver.receiverType,
          id: receiver.receiverId,
          name: invoice.customerName ?? '',
          address: present(receiver.address) ? builderAddress(receiver.address) : null,
        };

  const invoiceLines: EtaInvoiceLine[] = lines.map((line) => {
    const code = line.itemId === null ? undefined : codes.get(line.itemId);
    return {
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      discountBp: line.discountBp,
      taxRateBp: line.taxRateBp,
      internalCode: line.itemId === null ? null : (sku.get(line.itemId) ?? null),
      itemCode: code === undefined ? null : { itemType: code.itemType, itemCode: code.itemCode },
    };
  });

  const mappings: EtaMappings = {
    unitTypes,
    taxes: Object.fromEntries(
      taxes.map((tax) => [tax.taxRateBp, { taxType: tax.taxType, subType: tax.subType }]),
    ),
    defaultItemCode: settings.defaultItem,
  };

  return {
    issuer,
    receiver: receiverProfile,
    invoice: {
      internalId: invoice.reference === null ? '' : internalId(invoice.reference),
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      currencyCode: invoice.currencyCode,
      exchangeRate: invoice.currencyCode === 'EGP' ? null : exchangeRate,
      total: totals.total,
      lines: invoiceLines,
    },
    mappings,
    documentTypeVersion: settings.documentTypeVersion,
  };
}

// ---------------------------------------------------------------------------
// Errors as stored
// ---------------------------------------------------------------------------

export interface StoredError {
  code: string | null;
  message: string;
  target: string | null;
}

export function storedErrors(details: readonly EtaErrorDetail[]): StoredError[] {
  return details.slice(0, 50).map((detail) => ({
    code: detail.code?.slice(0, 200) ?? null,
    message: detail.message.slice(0, 1000),
    target: detail.target?.slice(0, 300) ?? null,
  }));
}

/**
 * What a failed call means for a submission. `unknown`: it may have reached
 * the ETA and been accepted, so it must not be sent again before someone
 * looks. `failed`: it definitely was not accepted, and may be sent again.
 *
 * SPEC-UNVERIFIED(submit-response): 409 and 422 are treated as unknown,
 * because the ETA answers a repeated submission with one of them and the
 * first may have been accepted.
 */
export function submissionFailureState(error: EtaApiError): 'failed' | 'unknown' {
  if (error.ambiguous || error.status === 409 || error.status === 422) {
    return 'unknown';
  }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * The ETA's status text to a document state. Null for a status that is not
 * final yet (`Submitted`) or not recognised: the document stays as it is.
 * SPEC-UNVERIFIED(status-values).
 */
export function stateForStatus(status: string | null): EtaDocumentState | null {
  switch (status?.trim().toLowerCase()) {
    case 'valid':
      return 'valid';
    case 'invalid':
      return 'invalid';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return null;
  }
}

export interface StatusOutcome {
  document: EtaDocumentRecord;
  /** Whether another check should be scheduled. */
  again: boolean;
}

/**
 * Asks the ETA for one document's status and records what it said. Never
 * throws for an ETA failure: the attempt is recorded and another check is
 * scheduled, up to `maxChecks`.
 */
export async function checkStatus(
  tx: TenantTransaction,
  client: EtaClient,
  document: EtaDocumentRecord,
  options: {
    maxChecks: number;
    actorId: string | null;
    now?: Date;
    /** Keep checking a valid document: a cancellation was asked for. */
    watchCancellation?: boolean;
  },
): Promise<StatusOutcome> {
  const now = options.now ?? new Date();
  if (document.etaUuid === null || !['submitted', 'valid'].includes(document.state)) {
    return { document, again: false };
  }
  const startedAt = new Date();
  const checks = document.checks + 1;
  const again =
    (document.state === 'submitted' || options.watchCancellation === true) &&
    checks < options.maxChecks;
  const nextCheckAt = again ? new Date(now.getTime() + nextCheckDelayMs(checks)) : null;
  try {
    const status = await client.documentStatus(document.etaUuid);
    await tx.eta.recordAttempt({
      documentId: document.id,
      kind: 'status',
      outcome: 'ok',
      httpStatus: 200,
      correlationId: status.correlationId,
      startedAt,
      actorId: options.actorId,
    });
    const next = stateForStatus(status.status);
    const patch = {
      etaStatus: status.status?.slice(0, 40) ?? null,
      etaLongId: status.longId ?? document.etaLongId,
      checks,
    };
    if (next !== null && next !== document.state) {
      const allowed: Record<string, readonly EtaDocumentState[]> = {
        submitted: ['valid', 'invalid', 'cancelled', 'rejected'],
        valid: ['cancelled'],
      };
      if (allowed[document.state]?.includes(next) === true) {
        const moved = await tx.eta.transition(
          document.id,
          [document.state],
          next === 'rejected' ? 'invalid' : next,
          {
            ...patch,
            finalAt: now,
            nextCheckAt: null,
            errors: storedErrors(status.validationErrors),
          },
        );
        return { document: moved ?? document, again: false };
      }
    }
    const kept = await tx.eta.transition(document.id, [document.state], document.state, {
      ...patch,
      nextCheckAt,
    });
    return { document: kept ?? document, again };
  } catch (error) {
    if (!(error instanceof EtaApiError)) {
      throw error;
    }
    await tx.eta.recordAttempt({
      documentId: document.id,
      kind: 'status',
      outcome: error.ambiguous ? 'unknown' : 'error',
      httpStatus: error.status,
      errorCode: error.code ?? error.kind,
      message: error.message,
      correlationId: error.correlationId,
      startedAt,
      actorId: options.actorId,
    });
    const kept = await tx.eta.transition(document.id, [document.state], document.state, {
      checks,
      nextCheckAt,
      lastErrorCode: `eta_${error.kind}`,
    });
    return { document: kept ?? document, again };
  }
}
