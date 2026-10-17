import { createHash } from 'node:crypto';
import {
  ETA_ENVIRONMENTS,
  ETA_ITEM_TYPES,
  ETA_MAPPABLE_UNITS,
  ETA_RECEIVER_TYPES,
} from '@integr8/core';
import { withTenant } from '@integr8/db';
import { describeCertificate } from '@integr8/eta';
import {
  certificateDer,
  compileSchema,
  EtaApiError,
  SchemaUnreadableError,
} from '@integr8/eta/node';
import { z } from 'zod';
import { ApiError, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { credentialHint, etaKey, sealCredential } from '../../eta/credentials.js';
import { environmentProblem, forgetTokens, openEtaClient } from '../../eta/services.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import {
  addressSchema,
  etaCode,
  etaText,
  FEATURE,
  keyOrRefuse,
  receiverSchema,
  refuseImpersonation,
  refuseProblem,
  settingsSchema,
  settingsView,
  TAGS,
} from './e-invoicing-shared.js';

/**
 * E-invoicing settings, credentials, certificates, codes and schemas
 * (docs/e-invoicing; ADR-0014). Each company enters its own ETA credentials;
 * they are sealed before they reach the database and never sent back.
 */

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const getEtaSettingsRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/settings',
  operationId: 'getEtaSettings',
  summary: 'The company’s e-invoicing settings',
  description:
    'Never includes the credentials themselves: only whether they are saved and the client id’s last four characters.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The settings.', schema: settingsSchema } },
  handler: async (_input, context) => {
    const settings = await withTenant(context.principal.tenantId, (tx) => tx.eta.settings());
    return { status: 200, body: settingsView(context, settings) };
  },
});

export const saveEtaSettingsRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/settings',
  operationId: 'saveEtaSettings',
  summary: 'Change the company’s e-invoicing settings',
  description:
    'With `expectedVersion` (0 for the first save; 409 `version_conflict`). Choosing `production` needs the server’s ETA_ALLOW_PRODUCTION (403 `eta_production_disabled`), the owner’s own session (403 `eta_production_owner_only`) and `confirmProduction: true`. Credentials and pinned certificates have their own routes.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(0),
    enabled: z.boolean(),
    environment: z.enum(ETA_ENVIRONMENTS),
    confirmProduction: z.boolean().optional(),
    taxpayerId: etaCode(30).nullable(),
    issuerName: etaText(200).nullable(),
    branchId: etaCode(20).nullable(),
    activityCode: etaCode(10).nullable(),
    address: addressSchema,
    intermediaryFor: etaCode(30).nullable(),
    documentTypeVersion: z.enum(['1.0']),
    defaultItem: z.object({ itemType: z.enum(ETA_ITEM_TYPES), itemCode: etaCode(100) }).nullable(),
  }),
  responses: {
    200: { description: 'The settings.', schema: settingsSchema },
    403: { description: 'Production is not allowed here, or not by this person.' },
    409: { description: 'Changed elsewhere.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.eta.settings();
      if (body.environment === 'production' && current.environment !== 'production') {
        const problem = environmentProblem(context.config, 'production');
        if (problem !== null) {
          refuseProblem(problem);
        }
        if (principal.role !== 'owner' || principal.impersonatedBy !== undefined) {
          throw forbidden('Only the company’s owner can switch e-invoicing to production.', [
            {
              field: 'body.environment',
              code: 'eta_production_owner_only',
              message: 'Ask the owner to make this change.',
            },
          ]);
        }
        if (body.confirmProduction !== true) {
          throw unprocessable(
            'eta_production_unconfirmed',
            'Confirm that documents will be sent to the real tax authority.',
            [
              {
                field: 'body.confirmProduction',
                code: 'eta_production_unconfirmed',
                message: 'Required.',
              },
            ],
          );
        }
      }
      const result = await tx.eta.saveSettings(
        {
          enabled: body.enabled,
          environment: body.environment,
          taxpayerId: body.taxpayerId,
          issuerName: body.issuerName,
          branchId: body.branchId,
          activityCode: body.activityCode,
          address: body.address,
          intermediaryFor: body.intermediaryFor,
          documentTypeVersion: body.documentTypeVersion,
          defaultItem: body.defaultItem,
        },
        principal.userId,
        body.expectedVersion,
      );
      if (result === undefined) {
        throw versionConflict();
      }
      await audit(tx, context, 'eta.settings_updated', 'eta_settings', principal.tenantId, {
        enabled: result.enabled,
        environment: result.environment,
        environmentChanged: current.environment !== result.environment,
      });
      return result;
    });
    forgetTokens(context.services.eta, principal.tenantId);
    return { status: 200, body: settingsView(context, saved) };
  },
});

export const saveEtaCredentialsRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/settings/credentials',
  operationId: 'saveEtaCredentials',
  summary: 'Save the company’s ETA client id and secret',
  description:
    'Write-only. Sealed with the server’s ETA_CREDENTIALS_KEY (503 `eta_key_missing`) before they are stored; never returned, logged or audited. Integr8 staff acting as the company are refused (403 `eta_staff_refused`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({
    clientId: z.string().trim().min(4).max(200),
    clientSecret: z.string().trim().min(4).max(500),
  }),
  responses: {
    200: { description: 'The settings.', schema: settingsSchema },
    403: { description: 'Staff acting as the company.' },
    503: { description: 'ETA_CREDENTIALS_KEY is not set.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'enter ETA credentials');
    const key = etaKey(keyOrRefuse(context));
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.eta.saveCredentials(
        {
          clientId: sealCredential(body.clientId, key, principal.tenantId, 'clientId'),
          clientSecret: sealCredential(body.clientSecret, key, principal.tenantId, 'clientSecret'),
          hint: credentialHint(body.clientId),
        },
        principal.userId,
      );
      await audit(tx, context, 'eta.credentials_saved', 'eta_settings', principal.tenantId, {
        credentialsVersion: result.credentialsVersion,
      });
      return result;
    });
    forgetTokens(context.services.eta, principal.tenantId);
    return { status: 200, body: settingsView(context, saved) };
  },
});

export const clearEtaCredentialsRoute = defineRoute({
  method: 'delete',
  path: '/v1/eta/settings/credentials',
  operationId: 'clearEtaCredentials',
  summary: 'Remove the company’s ETA credentials',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The settings.', schema: settingsSchema } },
  handler: async (_input, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.eta.clearCredentials(principal.userId);
      await audit(tx, context, 'eta.credentials_cleared', 'eta_settings', principal.tenantId, {
        credentialsVersion: result.credentialsVersion,
      });
      return result;
    });
    forgetTokens(context.services.eta, principal.tenantId);
    return { status: 200, body: settingsView(context, saved) };
  },
});

export const checkEtaCredentialsRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/settings/credentials/check',
  operationId: 'checkEtaCredentials',
  summary: 'Check the saved credentials with the ETA',
  description:
    'Asks the ETA for a token in the company’s environment. 422 `eta_credentials_rejected` when the ETA refuses them; 502 `eta_unreachable` when it cannot be reached. Works while e-invoicing is switched off, so a company can test before enabling.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The ETA accepted them.', schema: z.object({ ok: z.literal(true) }) },
    422: { description: 'The ETA refused them.' },
    502: { description: 'The ETA could not be reached.' },
  },
  handler: async (_input, context) => {
    const { principal } = context;
    const opened = await withTenant(principal.tenantId, async (tx) =>
      openEtaClient(
        { config: context.config, eta: context.services.eta },
        principal.tenantId,
        await tx.eta.settings(),
        await tx.eta.sealedCredentials(),
        { requireEnabled: false },
      ),
    );
    if ('problem' in opened) {
      refuseProblem(opened.problem);
    }
    const startedAt = new Date();
    try {
      await opened.client.checkCredentials();
      await withTenant(principal.tenantId, (tx) =>
        tx.eta.recordAttempt({
          documentId: null,
          kind: 'token',
          outcome: 'ok',
          httpStatus: 200,
          startedAt,
          actorId: principal.userId,
        }),
      );
      return { status: 200, body: { ok: true as const } };
    } catch (error) {
      if (!(error instanceof EtaApiError)) {
        throw error;
      }
      await withTenant(principal.tenantId, (tx) =>
        tx.eta.recordAttempt({
          documentId: null,
          kind: 'token',
          outcome: 'error',
          httpStatus: error.status,
          errorCode: error.code ?? error.kind,
          correlationId: error.correlationId,
          startedAt,
          actorId: principal.userId,
        }),
      );
      throw etaFailure(error);
    }
  },
});

/** An ETA failure, as this API words it. Nothing from the ETA's own text is echoed. */
export function etaFailure(error: EtaApiError): ApiError {
  if (error.kind === 'unauthorized' || error.kind === 'forbidden') {
    return unprocessable(
      'eta_credentials_rejected',
      'The tax authority refused the company’s credentials.',
    );
  }
  if (error.kind === 'rate_limited') {
    return new ApiError(
      429,
      'eta_rate_limited',
      'The tax authority asked us to slow down. Try again in a minute.',
    );
  }
  if (error.kind === 'not_found') {
    return new ApiError(502, 'eta_not_found', 'The tax authority does not know that document.');
  }
  if (error.kind === 'bad_request') {
    return new ApiError(502, 'eta_refused', 'The tax authority refused the request.');
  }
  return new ApiError(502, 'eta_unreachable', 'The tax authority could not be reached.');
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

const certificateViewSchema = z.object({
  sha256: z.string(),
  subject: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
});

export const pinEtaCertificatesRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/settings/certificates',
  operationId: 'pinEtaCertificates',
  summary: 'Set the certificates allowed to sign this company’s documents',
  description:
    'Each certificate as PEM or Base64 DER — the public certificate only, never a private key. Replaces the list; an empty list means nothing can be signed. Only signatures by one of these are accepted (ADR-0014 D6). The owner or an admin, on their own session.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({ certificates: z.array(z.string().min(100).max(20_000)).max(5) }),
  responses: {
    200: {
      description: 'The settings and what each certificate is.',
      schema: z.object({ settings: settingsSchema, certificates: z.array(certificateViewSchema) }),
    },
    422: { description: 'Not a certificate, or a private key.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    refuseImpersonation(principal, 'choose signing certificates');
    const described = await Promise.all(
      body.certificates.map(async (text, index) => {
        if (text.includes('PRIVATE KEY')) {
          throw unprocessable(
            'eta_private_key_refused',
            'Send the certificate, never a private key.',
            [
              {
                field: `body.certificates.${String(index)}`,
                code: 'eta_private_key_refused',
                message: 'Remove the private key.',
              },
            ],
          );
        }
        try {
          const der = certificateDer(text);
          const info = await describeCertificate(der);
          return {
            sha256: info.sha256,
            subject: info.subject,
            issuer: info.issuer,
            serialNumber: info.serialNumber,
            notBefore: info.notBefore.toISOString(),
            notAfter: info.notAfter.toISOString(),
          };
        } catch {
          throw unprocessable(
            'eta_certificate_unreadable',
            'That is not a certificate we can read.',
            [
              {
                field: `body.certificates.${String(index)}`,
                code: 'eta_certificate_unreadable',
                message: 'Not an X.509 certificate.',
              },
            ],
          );
        }
      }),
    );
    const pins = [...new Set(described.map((entry) => entry.sha256))];
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.eta.setPinnedCertificates(pins, principal.userId);
      await audit(tx, context, 'eta.certificates_pinned', 'eta_settings', principal.tenantId, {
        certificates: pins,
      });
      return result;
    });
    return {
      status: 200,
      body: { settings: settingsView(context, saved), certificates: described },
    };
  },
});

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

const codesSchema = z.object({
  receivers: z.array(receiverSchema),
  itemCodes: z.array(
    z.object({ itemId: z.uuid(), itemType: z.enum(ETA_ITEM_TYPES), itemCode: z.string() }),
  ),
  unitTypes: z.record(z.string(), z.string()),
  taxMappings: z.array(
    z.object({ taxRateBp: z.number().int(), taxType: z.string(), subType: z.string() }),
  ),
});

export const getEtaCodesRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/codes',
  operationId: 'getEtaCodes',
  summary: 'The company’s ETA codes: receivers, item codes, units and taxes',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The codes.', schema: codesSchema } },
  handler: async (_input, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [receivers, itemCodes, unitTypes, taxMappings] = await Promise.all([
        tx.eta.receivers(),
        tx.eta.itemCodes(),
        tx.eta.unitTypes(),
        tx.eta.taxMappings(),
      ]);
      return {
        receivers: receivers.map((receiver) => ({
          ...receiver,
          updatedAt: receiver.updatedAt.toISOString(),
        })),
        itemCodes,
        unitTypes,
        taxMappings,
      };
    });
    return { status: 200, body };
  },
});

export const saveEtaReceiverRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/receivers/:customerId',
  operationId: 'saveEtaReceiver',
  summary: 'Set how a customer appears on ETA documents',
  description:
    '`B` business (registration number), `P` person (national id), `F` foreigner. The name comes from the invoice. 404 when the customer is not in this company.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: z.object({ customerId: z.uuid() }),
  query: noSchema,
  body: z.object({
    receiverType: z.enum(ETA_RECEIVER_TYPES),
    receiverId: etaCode(30).nullable(),
    address: addressSchema,
  }),
  responses: {
    200: { description: 'The receiver.', schema: receiverSchema },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const customer = await tx.customers.find(params.customerId);
      if (customer === undefined) {
        throw notFound('No such customer.');
      }
      const result = await tx.eta.saveReceiver({
        customerId: params.customerId,
        receiverType: body.receiverType,
        receiverId: body.receiverId,
        address: body.address,
        by: principal.userId,
      });
      await audit(tx, context, 'eta.receiver_saved', 'customer', params.customerId, {
        receiverType: body.receiverType,
      });
      return result;
    });
    return { status: 200, body: { ...saved, updatedAt: saved.updatedAt.toISOString() } };
  },
});

export const deleteEtaReceiverRoute = defineRoute({
  method: 'delete',
  path: '/v1/eta/receivers/:customerId',
  operationId: 'deleteEtaReceiver',
  summary: 'Forget a customer’s ETA receiver details',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: z.object({ customerId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Done.', schema: z.object({ deleted: z.boolean() }) } },
  handler: async ({ params }, context) => {
    const deleted = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.eta.deleteReceiver(params.customerId);
      if (result) {
        await audit(tx, context, 'eta.receiver_deleted', 'customer', params.customerId);
      }
      return result;
    });
    return { status: 200, body: { deleted } };
  },
});

export const saveEtaItemCodeRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/item-codes/:itemId',
  operationId: 'saveEtaItemCode',
  summary: 'Set a catalogue item’s ETA code (GS1 or EGS)',
  description:
    'The code as registered with the ETA; nothing here checks it against the ETA’s list.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: z.object({ itemType: z.enum(ETA_ITEM_TYPES), itemCode: etaCode(100) }),
  responses: {
    200: {
      description: 'The code.',
      schema: z.object({
        itemId: z.uuid(),
        itemType: z.enum(ETA_ITEM_TYPES),
        itemCode: z.string(),
      }),
    },
    404: { description: 'No such item.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const [item] = await tx.inventoryCatalogue.findItems([params.itemId]);
      if (item === undefined) {
        throw notFound('No such item.');
      }
      const result = await tx.eta.saveItemCode({ ...params, ...body, by: principal.userId });
      await audit(tx, context, 'eta.item_code_saved', 'erp_item', params.itemId, {
        itemType: body.itemType,
      });
      return result;
    });
    return { status: 200, body: saved };
  },
});

export const deleteEtaItemCodeRoute = defineRoute({
  method: 'delete',
  path: '/v1/eta/item-codes/:itemId',
  operationId: 'deleteEtaItemCode',
  summary: 'Remove a catalogue item’s ETA code',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: z.object({ itemId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Done.', schema: z.object({ deleted: z.boolean() }) } },
  handler: async ({ params }, context) => {
    const deleted = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.eta.deleteItemCode(params.itemId);
      if (result) {
        await audit(tx, context, 'eta.item_code_deleted', 'erp_item', params.itemId);
      }
      return result;
    });
    return { status: 200, body: { deleted } };
  },
});

export const saveEtaUnitTypesRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/unit-types',
  operationId: 'saveEtaUnitTypes',
  summary: 'Map Integr8 units to ETA unit type codes',
  description:
    'Replaces the whole mapping; units left out are unmapped. Codes come from the ETA’s unit types table.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({ unitTypes: z.partialRecord(z.enum(ETA_MAPPABLE_UNITS), etaCode(20)) }),
  responses: {
    200: {
      description: 'The mapping.',
      schema: z.object({ unitTypes: z.record(z.string(), z.string()) }),
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const unitTypes = await withTenant(principal.tenantId, async (tx) => {
      const mapping = Object.fromEntries(
        Object.entries(body.unitTypes).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      );
      const result = await tx.eta.replaceUnitTypes(mapping, principal.userId);
      await audit(tx, context, 'eta.unit_types_saved', 'eta_settings', principal.tenantId, {
        units: Object.keys(result),
      });
      return result;
    });
    return { status: 200, body: { unitTypes } };
  },
});

export const saveEtaTaxMappingsRoute = defineRoute({
  method: 'put',
  path: '/v1/eta/tax-mappings',
  operationId: 'saveEtaTaxMappings',
  summary: 'Map invoice tax rates to ETA tax types and subtypes',
  description:
    'Replaces the whole mapping. One entry per rate in basis points (1400 is 14%); type and subtype come from the ETA’s tax types table. 422 `eta_tax_rate_repeated`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({
    taxMappings: z
      .array(
        z.object({
          taxRateBp: z.number().int().min(0).max(10_000),
          taxType: etaCode(10),
          subType: etaCode(20),
        }),
      )
      .max(50),
  }),
  responses: {
    200: {
      description: 'The mapping.',
      schema: z.object({
        taxMappings: z.array(
          z.object({ taxRateBp: z.number().int(), taxType: z.string(), subType: z.string() }),
        ),
      }),
    },
    422: { description: 'A rate given twice.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const rates = body.taxMappings.map((entry) => entry.taxRateBp);
    if (new Set(rates).size !== rates.length) {
      throw unprocessable('eta_tax_rate_repeated', 'Give each tax rate once.');
    }
    const taxMappings = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.eta.replaceTaxMappings(body.taxMappings, principal.userId);
      await audit(tx, context, 'eta.tax_mappings_saved', 'eta_settings', principal.tenantId, {
        rates,
      });
      return result;
    });
    return { status: 200, body: { taxMappings } };
  },
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const schemaSummary = z.object({
  environment: z.enum(ETA_ENVIRONMENTS),
  documentType: z.string(),
  typeVersion: z.string(),
  etaTypeId: z.string(),
  etaVersionId: z.string(),
  schemaSha256: z.string(),
  fetchedAt: z.iso.datetime(),
});

export const listEtaSchemasRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/schemas',
  operationId: 'listEtaSchemas',
  summary: 'The ETA document schemas this company has fetched',
  description:
    'A document is submitted only after it validates against the schema for its environment, type and version.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.read',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The schemas.', schema: z.object({ items: z.array(schemaSummary) }) },
  },
  handler: async (_input, context) => {
    const items = await withTenant(context.principal.tenantId, (tx) => tx.eta.schemas());
    return {
      status: 200,
      body: {
        items: items.map((item) => ({
          environment: item.environment,
          documentType: item.documentType,
          typeVersion: item.typeVersion,
          etaTypeId: item.etaTypeId,
          etaVersionId: item.etaVersionId,
          schemaSha256: item.schemaSha256,
          fetchedAt: item.fetchedAt.toISOString(),
        })),
      },
    };
  },
});

export const availableEtaSchemasRoute = defineRoute({
  method: 'get',
  path: '/v1/eta/schemas/available',
  operationId: 'availableEtaSchemas',
  summary: 'Document types and versions as the ETA lists them',
  description:
    'Read from the ETA with the company’s credentials, so the person fetching a schema picks the exact type and version ids the ETA uses.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The types.',
      schema: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            name: z.string().nullable(),
            versions: z.array(
              z.object({
                id: z.string(),
                number: z.string().nullable(),
                status: z.string().nullable(),
              }),
            ),
          }),
        ),
      }),
    },
    502: { description: 'The ETA could not be reached.' },
  },
  handler: async (_input, context) => {
    const { principal } = context;
    const opened = await withTenant(principal.tenantId, async (tx) =>
      openEtaClient(
        { config: context.config, eta: context.services.eta },
        principal.tenantId,
        await tx.eta.settings(),
        await tx.eta.sealedCredentials(),
        { requireEnabled: false },
      ),
    );
    if ('problem' in opened) {
      refuseProblem(opened.problem);
    }
    try {
      return { status: 200, body: { items: await opened.client.documentTypes() } };
    } catch (error) {
      if (error instanceof EtaApiError) {
        throw etaFailure(error);
      }
      throw error;
    }
  },
});

export const fetchEtaSchemaRoute = defineRoute({
  method: 'post',
  path: '/v1/eta/schemas/fetch',
  operationId: 'fetchEtaSchema',
  summary: 'Fetch and keep one document schema from the ETA',
  description:
    'Fetches `GET /api/v1.0/documenttypes/{etaTypeId}/versions/{etaVersionId}` with the company’s credentials, decodes its JSON Schema and keeps it for the company’s environment under `documentType` and `typeVersion`. 422 `eta_schema_unreadable` when it does not compile.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'eta.configure',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: z.object({
    etaTypeId: etaCode(40),
    etaVersionId: etaCode(40),
    documentType: z.enum(['I']),
    typeVersion: z.enum(['1.0']),
  }),
  responses: {
    200: { description: 'The schema kept.', schema: schemaSummary },
    422: { description: 'Not a usable schema.' },
    502: { description: 'The ETA could not be reached.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const { opened, environment } = await withTenant(principal.tenantId, async (tx) => {
      const settings = await tx.eta.settings();
      return {
        environment: settings.environment,
        opened: openEtaClient(
          { config: context.config, eta: context.services.eta },
          principal.tenantId,
          settings,
          await tx.eta.sealedCredentials(),
          { requireEnabled: false },
        ),
      };
    });
    if ('problem' in opened) {
      refuseProblem(opened.problem);
    }
    const startedAt = new Date();
    let fetched;
    try {
      fetched = await opened.client.documentTypeVersion(body.etaTypeId, body.etaVersionId);
    } catch (error) {
      if (!(error instanceof EtaApiError)) {
        throw error;
      }
      await withTenant(principal.tenantId, (tx) =>
        tx.eta.recordAttempt({
          documentId: null,
          kind: 'schema',
          outcome: 'error',
          httpStatus: error.status,
          errorCode: error.code ?? error.kind,
          correlationId: error.correlationId,
          startedAt,
          actorId: principal.userId,
        }),
      );
      throw etaFailure(error);
    }
    try {
      compileSchema(fetched.schemaText);
    } catch (error) {
      if (error instanceof SchemaUnreadableError) {
        throw unprocessable(
          'eta_schema_unreadable',
          'The ETA’s answer is not a schema we can use.',
        );
      }
      throw error;
    }
    const schemaSha256 = createHash('sha256').update(fetched.schemaText, 'utf8').digest('hex');
    await withTenant(principal.tenantId, async (tx) => {
      await tx.eta.saveSchema({
        environment,
        documentType: body.documentType,
        typeVersion: body.typeVersion,
        etaTypeId: body.etaTypeId,
        etaVersionId: body.etaVersionId,
        schemaText: fetched.schemaText,
        schemaSha256,
        fetchedBy: principal.userId,
      });
      await tx.eta.recordAttempt({
        documentId: null,
        kind: 'schema',
        outcome: 'ok',
        httpStatus: 200,
        correlationId: fetched.correlationId,
        startedAt,
        actorId: principal.userId,
      });
      await audit(tx, context, 'eta.schema_fetched', 'eta_settings', principal.tenantId, {
        environment,
        documentType: body.documentType,
        typeVersion: body.typeVersion,
        schemaSha256,
      });
    });
    return {
      status: 200,
      body: {
        environment,
        documentType: body.documentType,
        typeVersion: body.typeVersion,
        etaTypeId: body.etaTypeId,
        etaVersionId: body.etaVersionId,
        schemaSha256,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

export const etaSettingsRoutes = [
  getEtaSettingsRoute,
  saveEtaSettingsRoute,
  saveEtaCredentialsRoute,
  clearEtaCredentialsRoute,
  checkEtaCredentialsRoute,
  pinEtaCertificatesRoute,
  getEtaCodesRoute,
  saveEtaReceiverRoute,
  deleteEtaReceiverRoute,
  saveEtaItemCodeRoute,
  deleteEtaItemCodeRoute,
  saveEtaUnitTypesRoute,
  saveEtaTaxMappingsRoute,
  listEtaSchemasRoute,
  availableEtaSchemasRoute,
  fetchEtaSchemaRoute,
];
