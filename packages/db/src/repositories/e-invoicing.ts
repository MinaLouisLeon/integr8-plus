import type {
  EtaAttemptKind,
  EtaAttemptOutcome,
  EtaDocumentKind,
  EtaDocumentState,
  EtaEnvironment,
  EtaItemType,
  EtaReceiverType,
  EtaSigningStatus,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  EtaAddressColumns,
  EtaDocumentsTable,
  EtaReceiversTable,
  EtaSettingsTable,
  EtaSigningRequestsTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Egyptian e-invoicing (ADR-0014): a company's settings and codes, the ETA
 * documents made from its invoices, every call made about them, signing
 * requests and fetched schemas.
 *
 * The sealed credentials are read by one method only (`sealedCredentials`),
 * for the API to open on the server; every other read leaves them out.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface EtaAddress {
  country: string | null;
  governate: string | null;
  regionCity: string | null;
  street: string | null;
  buildingNumber: string | null;
  postalCode: string | null;
  floor: string | null;
  room: string | null;
  landmark: string | null;
  additionalInformation: string | null;
}

export interface EtaSettings {
  enabled: boolean;
  environment: EtaEnvironment;
  issuerType: string;
  taxpayerId: string | null;
  issuerName: string | null;
  branchId: string | null;
  activityCode: string | null;
  address: EtaAddress;
  hasCredentials: boolean;
  /** The client id's last four characters. */
  credentialsHint: string | null;
  credentialsVersion: number;
  credentialsUpdatedAt: Date | null;
  intermediaryFor: string | null;
  documentTypeVersion: string;
  defaultItem: { itemType: EtaItemType; itemCode: string } | null;
  pinnedCertificates: string[];
  version: number;
  updatedAt: Date | null;
}

export const EMPTY_ETA_ADDRESS: EtaAddress = {
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

export const DEFAULT_ETA_SETTINGS: EtaSettings = {
  enabled: false,
  environment: 'preprod',
  issuerType: 'B',
  taxpayerId: null,
  issuerName: null,
  branchId: null,
  activityCode: null,
  address: EMPTY_ETA_ADDRESS,
  hasCredentials: false,
  credentialsHint: null,
  credentialsVersion: 0,
  credentialsUpdatedAt: null,
  intermediaryFor: null,
  documentTypeVersion: '1.0',
  defaultItem: null,
  pinnedCertificates: [],
  version: 0,
  updatedAt: null,
};

export interface EtaSettingsInput {
  enabled: boolean;
  environment: EtaEnvironment;
  taxpayerId: string | null;
  issuerName: string | null;
  branchId: string | null;
  activityCode: string | null;
  address: EtaAddress;
  intermediaryFor: string | null;
  documentTypeVersion: string;
  defaultItem: { itemType: EtaItemType; itemCode: string } | null;
}

function addressOf(row: EtaAddressColumns): EtaAddress {
  return {
    country: row.address_country,
    governate: row.address_governate,
    regionCity: row.address_region_city,
    street: row.address_street,
    buildingNumber: row.address_building_number,
    postalCode: row.address_postal_code,
    floor: row.address_floor,
    room: row.address_room,
    landmark: row.address_landmark,
    additionalInformation: row.address_additional,
  };
}

function addressColumns(address: EtaAddress): EtaAddressColumns {
  return {
    address_country: address.country,
    address_governate: address.governate,
    address_region_city: address.regionCity,
    address_street: address.street,
    address_building_number: address.buildingNumber,
    address_postal_code: address.postalCode,
    address_floor: address.floor,
    address_room: address.room,
    address_landmark: address.landmark,
    address_additional: address.additionalInformation,
  };
}

function toSettings(row: Selectable<EtaSettingsTable>): EtaSettings {
  return {
    enabled: row.enabled,
    environment: row.environment,
    issuerType: row.issuer_type,
    taxpayerId: row.taxpayer_id,
    issuerName: row.issuer_name,
    branchId: row.branch_id,
    activityCode: row.activity_code,
    address: addressOf(row),
    hasCredentials: row.client_id_sealed !== null,
    credentialsHint: row.credentials_hint,
    credentialsVersion: row.credentials_version,
    credentialsUpdatedAt: row.credentials_updated_at,
    intermediaryFor: row.intermediary_for,
    documentTypeVersion: row.document_type_version,
    defaultItem:
      row.default_item_type === null || row.default_item_code === null
        ? null
        : { itemType: row.default_item_type, itemCode: row.default_item_code },
    pinnedCertificates: row.pinned_certificates,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

export interface EtaReceiver {
  customerId: string;
  receiverType: EtaReceiverType;
  receiverId: string | null;
  address: EtaAddress;
  updatedAt: Date;
}

function toReceiver(row: Selectable<EtaReceiversTable>): EtaReceiver {
  return {
    customerId: row.customer_id,
    receiverType: row.receiver_type,
    receiverId: row.receiver_id,
    address: addressOf(row),
    updatedAt: row.updated_at,
  };
}

export interface EtaItemCode {
  itemId: string;
  itemType: EtaItemType;
  itemCode: string;
}

export interface EtaTaxMapping {
  taxRateBp: number;
  taxType: string;
  subType: string;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface EtaDocumentRecord {
  id: string;
  kind: EtaDocumentKind;
  invoiceId: string;
  sequence: number;
  environment: EtaEnvironment;
  internalId: string;
  state: EtaDocumentState;
  canonicalSha256: string;
  signerCertificate: string | null;
  signedBy: string | null;
  signedAt: Date | null;
  exchangeRate: string | null;
  totalAmount: string;
  currencyCode: string;
  etaUuid: string | null;
  etaLongId: string | null;
  submissionId: string | null;
  etaStatus: string | null;
  errors: unknown[];
  lastErrorCode: string | null;
  preparedBy: string;
  preparedAt: Date;
  submittedBy: string | null;
  submittedAt: Date | null;
  finalAt: Date | null;
  nextCheckAt: Date | null;
  checks: number;
  version: number;
  updatedAt: Date;
}

function toDocument(
  row: Omit<Selectable<EtaDocumentsTable>, 'unsigned_json' | 'signed_json'>,
): EtaDocumentRecord {
  return {
    id: row.id,
    kind: row.document_kind,
    invoiceId: row.invoice_id,
    sequence: row.sequence,
    environment: row.environment,
    internalId: row.internal_id,
    state: row.state,
    canonicalSha256: row.canonical_sha256,
    signerCertificate: row.signer_certificate,
    signedBy: row.signed_by,
    signedAt: row.signed_at,
    exchangeRate: row.exchange_rate,
    totalAmount: row.total_amount,
    currencyCode: row.currency_code,
    etaUuid: row.eta_uuid,
    etaLongId: row.eta_long_id,
    submissionId: row.submission_id,
    etaStatus: row.eta_status,
    errors: row.errors,
    lastErrorCode: row.last_error_code,
    preparedBy: row.prepared_by,
    preparedAt: row.prepared_at,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at,
    finalAt: row.final_at,
    nextCheckAt: row.next_check_at,
    checks: row.checks,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

/** Every column but the two document texts, which only the routes that need them read. */
const DOCUMENT_COLUMNS = [
  'id',
  'tenant_id',
  'document_kind',
  'invoice_id',
  'sequence',
  'environment',
  'internal_id',
  'state',
  'canonical_sha256',
  'signer_certificate',
  'signed_by',
  'signed_at',
  'exchange_rate',
  'total_amount',
  'currency_code',
  'eta_uuid',
  'eta_long_id',
  'submission_id',
  'eta_status',
  'errors',
  'last_error_code',
  'prepared_by',
  'prepared_at',
  'submitted_by',
  'submitted_at',
  'final_at',
  'next_check_at',
  'checks',
  'version',
  'updated_at',
] as const;

export interface EtaDocumentPatch {
  etaUuid?: string | null;
  etaLongId?: string | null;
  submissionId?: string | null;
  etaStatus?: string | null;
  errors?: unknown[];
  lastErrorCode?: string | null;
  submittedBy?: string;
  submittedAt?: Date;
  finalAt?: Date | null;
  nextCheckAt?: Date | null;
  checks?: number;
  signed?: { json: string; certificate: string; by: string; at: Date };
}

export interface EtaAttempt {
  id: string;
  documentId: string | null;
  kind: EtaAttemptKind;
  outcome: EtaAttemptOutcome;
  httpStatus: number | null;
  errorCode: string | null;
  message: string | null;
  correlationId: string | null;
  startedAt: Date;
  finishedAt: Date;
  actorId: string | null;
}

export interface EtaSigningRequest {
  id: string;
  documentId: string;
  digest: string;
  nonce: string;
  status: EtaSigningStatus;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
  claimedBy: string | null;
  claimedAt: Date | null;
  finishedAt: Date | null;
  failure: string | null;
}

function toSigningRequest(row: Selectable<EtaSigningRequestsTable>): EtaSigningRequest {
  return {
    id: row.id,
    documentId: row.document_id,
    digest: row.digest,
    nonce: row.nonce,
    status: row.status,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    failure: row.failure,
  };
}

export interface EtaSchemaRecord {
  environment: EtaEnvironment;
  documentType: string;
  typeVersion: string;
  etaTypeId: string;
  etaVersionId: string;
  schemaText: string;
  schemaSha256: string;
  fetchedBy: string;
  fetchedAt: Date;
}

export class EtaRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async settings(): Promise<EtaSettings> {
    const row = await this.db
      .selectFrom('eta_settings')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row === undefined ? DEFAULT_ETA_SETTINGS : toSettings(row);
  }

  /** The sealed client id and secret, for the API to open. Nothing else reads them. */
  async sealedCredentials(): Promise<
    { clientId: string; clientSecret: string; version: number } | undefined
  > {
    const row = await this.db
      .selectFrom('eta_settings')
      .select(['client_id_sealed', 'client_secret_sealed', 'credentials_version'])
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row?.client_id_sealed === null || row?.client_secret_sealed === null || row === undefined
      ? undefined
      : {
          clientId: row.client_id_sealed,
          clientSecret: row.client_secret_sealed,
          version: row.credentials_version,
        };
  }

  /** Saves everything but the credentials and the pins. Undefined on a version conflict. */
  async saveSettings(
    input: EtaSettingsInput,
    by: string,
    expectedVersion: number,
  ): Promise<EtaSettings | undefined> {
    const values = {
      enabled: input.enabled,
      environment: input.environment,
      taxpayer_id: input.taxpayerId,
      issuer_name: input.issuerName,
      branch_id: input.branchId,
      activity_code: input.activityCode,
      ...addressColumns(input.address),
      intermediary_for: input.intermediaryFor,
      document_type_version: input.documentTypeVersion,
      default_item_type: input.defaultItem?.itemType ?? null,
      default_item_code: input.defaultItem?.itemCode ?? null,
      updated_by: by,
    };
    if (expectedVersion === 0) {
      const row = await this.db
        .insertInto('eta_settings')
        .values({ tenant_id: this.tenantId, ...values })
        .onConflict((oc) => oc.column('tenant_id').doNothing())
        .returningAll()
        .executeTakeFirst();
      return row === undefined ? undefined : toSettings(row);
    }
    const row = await this.db
      .updateTable('eta_settings')
      .set({ ...values, version: sql`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSettings(row);
  }

  async #ensureRow(by: string): Promise<void> {
    await this.db
      .insertInto('eta_settings')
      .values({ tenant_id: this.tenantId, updated_by: by })
      .onConflict((oc) => oc.column('tenant_id').doNothing())
      .execute();
  }

  /** Replaces the sealed credentials; the version moves, so cached tokens are dropped. */
  async saveCredentials(
    sealed: { clientId: string; clientSecret: string; hint: string },
    by: string,
  ): Promise<EtaSettings> {
    await this.#ensureRow(by);
    const row = await this.db
      .updateTable('eta_settings')
      .set({
        client_id_sealed: sealed.clientId,
        client_secret_sealed: sealed.clientSecret,
        credentials_hint: sealed.hint,
        credentials_version: sql`credentials_version + 1`,
        credentials_updated_at: new Date(),
        credentials_updated_by: by,
        updated_by: by,
        version: sql`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSettings(row);
  }

  async clearCredentials(by: string): Promise<EtaSettings> {
    await this.#ensureRow(by);
    const row = await this.db
      .updateTable('eta_settings')
      .set({
        client_id_sealed: null,
        client_secret_sealed: null,
        credentials_hint: null,
        credentials_version: sql`credentials_version + 1`,
        credentials_updated_at: new Date(),
        credentials_updated_by: by,
        updated_by: by,
        version: sql`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSettings(row);
  }

  async setPinnedCertificates(pins: readonly string[], by: string): Promise<EtaSettings> {
    await this.#ensureRow(by);
    const row = await this.db
      .updateTable('eta_settings')
      .set({ pinned_certificates: [...pins], updated_by: by, version: sql`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSettings(row);
  }

  // -------------------------------------------------------------------------
  // Receivers
  // -------------------------------------------------------------------------

  async receivers(customerIds?: readonly string[]): Promise<EtaReceiver[]> {
    let query = this.db
      .selectFrom('eta_receivers')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (customerIds !== undefined) {
      if (customerIds.length === 0) {
        return [];
      }
      query = query.where('customer_id', 'in', [...customerIds]);
    }
    return (await query.orderBy('customer_id').execute()).map(toReceiver);
  }

  async receiver(customerId: string): Promise<EtaReceiver | undefined> {
    return (await this.receivers([customerId]))[0];
  }

  async saveReceiver(input: {
    customerId: string;
    receiverType: EtaReceiverType;
    receiverId: string | null;
    address: EtaAddress;
    by: string;
  }): Promise<EtaReceiver> {
    const values = {
      receiver_type: input.receiverType,
      receiver_id: input.receiverId,
      ...addressColumns(input.address),
      updated_by: input.by,
    };
    const row = await this.db
      .insertInto('eta_receivers')
      .values({ tenant_id: this.tenantId, customer_id: input.customerId, ...values })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'customer_id']).doUpdateSet({ ...values, updated_at: new Date() }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReceiver(row);
  }

  async deleteReceiver(customerId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('eta_receivers')
      .where('tenant_id', '=', this.tenantId)
      .where('customer_id', '=', customerId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  // -------------------------------------------------------------------------
  // Item codes, units, taxes
  // -------------------------------------------------------------------------

  async itemCodes(itemIds?: readonly string[]): Promise<EtaItemCode[]> {
    let query = this.db
      .selectFrom('eta_item_codes')
      .select(['item_id', 'item_type', 'item_code'])
      .where('tenant_id', '=', this.tenantId);
    if (itemIds !== undefined) {
      if (itemIds.length === 0) {
        return [];
      }
      query = query.where('item_id', 'in', [...itemIds]);
    }
    return (await query.orderBy('item_id').execute()).map((row) => ({
      itemId: row.item_id,
      itemType: row.item_type,
      itemCode: row.item_code,
    }));
  }

  async saveItemCode(input: {
    itemId: string;
    itemType: EtaItemType;
    itemCode: string;
    by: string;
  }): Promise<EtaItemCode> {
    const values = { item_type: input.itemType, item_code: input.itemCode, updated_by: input.by };
    await this.db
      .insertInto('eta_item_codes')
      .values({ tenant_id: this.tenantId, item_id: input.itemId, ...values })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'item_id']).doUpdateSet({ ...values, updated_at: new Date() }),
      )
      .execute();
    return { itemId: input.itemId, itemType: input.itemType, itemCode: input.itemCode };
  }

  async deleteItemCode(itemId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('eta_item_codes')
      .where('tenant_id', '=', this.tenantId)
      .where('item_id', '=', itemId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async unitTypes(): Promise<Record<string, string>> {
    const rows = await this.db
      .selectFrom('eta_unit_types')
      .select(['unit', 'eta_unit_type'])
      .where('tenant_id', '=', this.tenantId)
      .execute();
    return Object.fromEntries(rows.map((row) => [row.unit, row.eta_unit_type]));
  }

  /** Replaces the whole unit mapping: units left out are unmapped. */
  async replaceUnitTypes(
    mapping: Readonly<Record<string, string>>,
    by: string,
  ): Promise<Record<string, string>> {
    await this.db.deleteFrom('eta_unit_types').where('tenant_id', '=', this.tenantId).execute();
    const rows = Object.entries(mapping).map(([unit, code]) => ({
      tenant_id: this.tenantId,
      unit,
      eta_unit_type: code,
      updated_by: by,
    }));
    if (rows.length > 0) {
      await this.db.insertInto('eta_unit_types').values(rows).execute();
    }
    return this.unitTypes();
  }

  async taxMappings(): Promise<EtaTaxMapping[]> {
    const rows = await this.db
      .selectFrom('eta_tax_mappings')
      .select(['tax_rate_bp', 'tax_type', 'sub_type'])
      .where('tenant_id', '=', this.tenantId)
      .orderBy('tax_rate_bp')
      .execute();
    return rows.map((row) => ({
      taxRateBp: row.tax_rate_bp,
      taxType: row.tax_type,
      subType: row.sub_type,
    }));
  }

  /** Replaces the whole tax mapping. */
  async replaceTaxMappings(
    mappings: readonly EtaTaxMapping[],
    by: string,
  ): Promise<EtaTaxMapping[]> {
    await this.db.deleteFrom('eta_tax_mappings').where('tenant_id', '=', this.tenantId).execute();
    if (mappings.length > 0) {
      await this.db
        .insertInto('eta_tax_mappings')
        .values(
          mappings.map((mapping) => ({
            tenant_id: this.tenantId,
            tax_rate_bp: mapping.taxRateBp,
            tax_type: mapping.taxType,
            sub_type: mapping.subType,
            updated_by: by,
          })),
        )
        .execute();
    }
    return this.taxMappings();
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  #documents() {
    return this.db
      .selectFrom('eta_documents')
      .select(DOCUMENT_COLUMNS)
      .where('eta_documents.tenant_id', '=', this.tenantId);
  }

  async document(id: string): Promise<EtaDocumentRecord | undefined> {
    const row = await this.#documents().where('id', '=', id).executeTakeFirst();
    return row === undefined ? undefined : toDocument(row);
  }

  /** The exact texts: the unsigned snapshot and, once signed, what is submitted. */
  async documentTexts(
    id: string,
  ): Promise<{ unsigned: string; signed: string | null } | undefined> {
    const row = await this.db
      .selectFrom('eta_documents')
      .select(['unsigned_json', 'signed_json'])
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : { unsigned: row.unsigned_json, signed: row.signed_json };
  }

  /** Every document made from an invoice, newest first. */
  async documentsForInvoice(invoiceId: string): Promise<EtaDocumentRecord[]> {
    return (
      await this.#documents()
        .where('invoice_id', '=', invoiceId)
        .orderBy('sequence', 'desc')
        .execute()
    ).map(toDocument);
  }

  async liveDocumentForInvoice(invoiceId: string): Promise<EtaDocumentRecord | undefined> {
    const row = await this.#documents()
      .where('invoice_id', '=', invoiceId)
      .where('state', 'not in', ['superseded', 'invalid', 'rejected', 'cancelled'])
      .executeTakeFirst();
    return row === undefined ? undefined : toDocument(row);
  }

  async listDocuments(query: {
    states?: readonly EtaDocumentState[];
    limit: number;
    before?: { preparedAt: Date; id: string };
  }): Promise<EtaDocumentRecord[]> {
    let select = this.#documents();
    if (query.states !== undefined && query.states.length > 0) {
      select = select.where('state', 'in', [...query.states]);
    }
    if (query.before !== undefined) {
      const { preparedAt, id } = query.before;
      select = select.where((eb) =>
        eb.or([
          eb('prepared_at', '<', preparedAt),
          eb.and([eb('prepared_at', '=', preparedAt), eb('id', '<', id)]),
        ]),
      );
    }
    return (
      await select.orderBy('prepared_at', 'desc').orderBy('id', 'desc').limit(query.limit).execute()
    ).map(toDocument);
  }

  async createDocument(input: {
    id: string;
    invoiceId: string;
    environment: EtaEnvironment;
    internalId: string;
    unsignedJson: string;
    canonicalSha256: string;
    exchangeRate: string | null;
    totalAmount: string;
    currencyCode: string;
    by: string;
  }): Promise<EtaDocumentRecord> {
    const last = await this.db
      .selectFrom('eta_documents')
      .select(sql<number>`coalesce(max(sequence), 0)`.as('last'))
      .where('tenant_id', '=', this.tenantId)
      .where('invoice_id', '=', input.invoiceId)
      .executeTakeFirstOrThrow();
    await this.db
      .insertInto('eta_documents')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        invoice_id: input.invoiceId,
        sequence: Number(last.last) + 1,
        environment: input.environment,
        internal_id: input.internalId,
        unsigned_json: input.unsignedJson,
        canonical_sha256: input.canonicalSha256,
        exchange_rate: input.exchangeRate,
        total_amount: input.totalAmount,
        currency_code: input.currencyCode,
        prepared_by: input.by,
      })
      .execute();
    return (await this.document(input.id))!;
  }

  /**
   * Moves a document from one of `from` to `to`, with the patch, in one
   * statement. Undefined when the document was not in one of `from` (someone
   * else moved it first): the caller decides what that means.
   */
  async transition(
    id: string,
    from: readonly EtaDocumentState[],
    to: EtaDocumentState,
    patch: EtaDocumentPatch = {},
  ): Promise<EtaDocumentRecord | undefined> {
    const row = await this.db
      .updateTable('eta_documents')
      .set({
        state: to,
        version: sql`version + 1`,
        ...(patch.etaUuid === undefined ? {} : { eta_uuid: patch.etaUuid }),
        ...(patch.etaLongId === undefined ? {} : { eta_long_id: patch.etaLongId }),
        ...(patch.submissionId === undefined ? {} : { submission_id: patch.submissionId }),
        ...(patch.etaStatus === undefined ? {} : { eta_status: patch.etaStatus }),
        ...(patch.errors === undefined
          ? {}
          : { errors: JSON.stringify(patch.errors) as unknown as unknown[] }),
        ...(patch.lastErrorCode === undefined ? {} : { last_error_code: patch.lastErrorCode }),
        ...(patch.submittedBy === undefined ? {} : { submitted_by: patch.submittedBy }),
        ...(patch.submittedAt === undefined ? {} : { submitted_at: patch.submittedAt }),
        ...(patch.finalAt === undefined ? {} : { final_at: patch.finalAt }),
        ...(patch.nextCheckAt === undefined ? {} : { next_check_at: patch.nextCheckAt }),
        ...(patch.checks === undefined ? {} : { checks: patch.checks }),
        ...(patch.signed === undefined
          ? {}
          : {
              signed_json: patch.signed.json,
              signer_certificate: patch.signed.certificate,
              signed_by: patch.signed.by,
              signed_at: patch.signed.at,
            }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('state', 'in', [...from])
      .returning(DOCUMENT_COLUMNS)
      .executeTakeFirst();
    return row === undefined ? undefined : toDocument(row);
  }

  async recordAttempt(input: {
    documentId: string | null;
    kind: EtaAttemptKind;
    outcome: EtaAttemptOutcome;
    httpStatus?: number | null;
    errorCode?: string | null;
    message?: string | null;
    correlationId?: string | null;
    startedAt: Date;
    actorId?: string | null;
  }): Promise<void> {
    await this.db
      .insertInto('eta_attempts')
      .values({
        tenant_id: this.tenantId,
        document_id: input.documentId,
        kind: input.kind,
        outcome: input.outcome,
        http_status: input.httpStatus ?? null,
        error_code: input.errorCode?.slice(0, 200) ?? null,
        message: input.message?.slice(0, 1000) ?? null,
        correlation_id: input.correlationId?.slice(0, 100) ?? null,
        started_at: input.startedAt,
        finished_at: new Date(),
        actor_id: input.actorId ?? null,
      })
      .execute();
  }

  async attempts(documentId: string): Promise<EtaAttempt[]> {
    const rows = await this.db
      .selectFrom('eta_attempts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('document_id', '=', documentId)
      .orderBy('started_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      kind: row.kind,
      outcome: row.outcome,
      httpStatus: row.http_status,
      errorCode: row.error_code,
      message: row.message,
      correlationId: row.correlation_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      actorId: row.actor_id,
    }));
  }

  // -------------------------------------------------------------------------
  // Signing requests
  // -------------------------------------------------------------------------

  async createSigningRequest(input: {
    id: string;
    documentId: string;
    digest: string;
    nonce: string;
    expiresAt: Date;
    by: string;
  }): Promise<EtaSigningRequest> {
    const row = await this.db
      .insertInto('eta_signing_requests')
      .values({
        id: input.id,
        tenant_id: this.tenantId,
        document_id: input.documentId,
        digest: input.digest,
        nonce: input.nonce,
        expires_at: input.expiresAt,
        requested_by: input.by,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSigningRequest(row);
  }

  async signingRequest(id: string): Promise<EtaSigningRequest | undefined> {
    const row = await this.db
      .selectFrom('eta_signing_requests')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toSigningRequest(row);
  }

  /** Open and claimed requests, oldest first: the agent's queue. Expired ones are closed first. */
  async signingQueue(now: Date): Promise<EtaSigningRequest[]> {
    await this.expireSigningRequests(now);
    const rows = await this.db
      .selectFrom('eta_signing_requests')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('status', 'in', ['open', 'claimed'])
      .orderBy('requested_at')
      .limit(100)
      .execute();
    return rows.map(toSigningRequest);
  }

  /**
   * Closes requests past their expiry and returns their documents to
   * `ready`, so a new request can be made. Returns how many.
   */
  async expireSigningRequests(now: Date): Promise<number> {
    const expired = await this.db
      .updateTable('eta_signing_requests')
      .set({ status: 'expired', finished_at: now })
      .where('tenant_id', '=', this.tenantId)
      .where('status', 'in', ['open', 'claimed'])
      .where('expires_at', '<=', now)
      .returning('document_id')
      .execute();
    for (const { document_id } of expired) {
      await this.transition(document_id, ['pending_signature'], 'ready');
    }
    return expired.length;
  }

  /** Claims an open, unexpired request for one agent. Undefined when it is not claimable. */
  async claimSigningRequest(
    id: string,
    by: string,
    now: Date,
  ): Promise<EtaSigningRequest | undefined> {
    const row = await this.db
      .updateTable('eta_signing_requests')
      .set({ status: 'claimed', claimed_by: by, claimed_at: now })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('expires_at', '>', now)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'open'),
          eb.and([eb('status', '=', 'claimed'), eb('claimed_by', '=', by)]),
        ]),
      )
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSigningRequest(row);
  }

  async finishSigningRequest(
    id: string,
    status: 'completed' | 'cancelled' | 'expired',
    now: Date,
    failure: string | null = null,
  ): Promise<EtaSigningRequest | undefined> {
    const row = await this.db
      .updateTable('eta_signing_requests')
      .set({ status, finished_at: now, failure })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('status', 'in', ['open', 'claimed'])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSigningRequest(row);
  }

  async openSigningRequestFor(documentId: string): Promise<EtaSigningRequest | undefined> {
    const row = await this.db
      .selectFrom('eta_signing_requests')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('document_id', '=', documentId)
      .where('status', 'in', ['open', 'claimed'])
      .executeTakeFirst();
    return row === undefined ? undefined : toSigningRequest(row);
  }

  // -------------------------------------------------------------------------
  // Schemas
  // -------------------------------------------------------------------------

  async schema(
    environment: EtaEnvironment,
    documentType: string,
    typeVersion: string,
  ): Promise<EtaSchemaRecord | undefined> {
    const row = await this.db
      .selectFrom('eta_schemas')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('environment', '=', environment)
      .where('document_type', '=', documentType)
      .where('type_version', '=', typeVersion)
      .executeTakeFirst();
    return row === undefined
      ? undefined
      : {
          environment: row.environment,
          documentType: row.document_type,
          typeVersion: row.type_version,
          etaTypeId: row.eta_type_id,
          etaVersionId: row.eta_version_id,
          schemaText: row.schema_text,
          schemaSha256: row.schema_sha256,
          fetchedBy: row.fetched_by,
          fetchedAt: row.fetched_at,
        };
  }

  async schemas(): Promise<Omit<EtaSchemaRecord, 'schemaText'>[]> {
    const rows = await this.db
      .selectFrom('eta_schemas')
      .select([
        'environment',
        'document_type',
        'type_version',
        'eta_type_id',
        'eta_version_id',
        'schema_sha256',
        'fetched_by',
        'fetched_at',
      ])
      .where('tenant_id', '=', this.tenantId)
      .orderBy('fetched_at', 'desc')
      .execute();
    return rows.map((row) => ({
      environment: row.environment,
      documentType: row.document_type,
      typeVersion: row.type_version,
      etaTypeId: row.eta_type_id,
      etaVersionId: row.eta_version_id,
      schemaSha256: row.schema_sha256,
      fetchedBy: row.fetched_by,
      fetchedAt: row.fetched_at,
    }));
  }

  async saveSchema(input: Omit<EtaSchemaRecord, 'fetchedAt'>): Promise<void> {
    const values = {
      eta_type_id: input.etaTypeId,
      eta_version_id: input.etaVersionId,
      schema_text: input.schemaText,
      schema_sha256: input.schemaSha256,
      fetched_by: input.fetchedBy,
    };
    await this.db
      .insertInto('eta_schemas')
      .values({
        tenant_id: this.tenantId,
        environment: input.environment,
        document_type: input.documentType,
        type_version: input.typeVersion,
        ...values,
      })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'environment', 'document_type', 'type_version'])
          .doUpdateSet({ ...values, fetched_at: new Date() }),
      )
      .execute();
  }
}
