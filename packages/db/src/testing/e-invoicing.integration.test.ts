import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_ETA_ADDRESS } from '../repositories/e-invoicing.js';
import type { Invoice } from '../repositories/finance-invoices.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0049 (ADR-0014): what the database keeps true for e-invoicing
 * whatever the API does — settings and sealed credentials per company, an
 * ETA document's snapshot that never changes and a signature written once,
 * nothing past signing without a signed document, one live document per
 * invoice, signing requests that expire, and no company reading another's rows.
 */

const USER = '00000000-0000-4000-8000-00000000e701';
const DIGEST = 'a'.repeat(64);
const NONCE = 'b'.repeat(64);

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('eta-northwind');
  southgate = await createTenant('eta-southgate');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function issuedInvoice(tenant: TenantFixture): Promise<Invoice> {
  const customer = await repos(tenant, (tx) => tx.customers.create({ name: 'Cairo Towers' }, USER));
  const draft = await repos(tenant, (tx) =>
    tx.financeInvoices.createInvoice(
      { customerId: customer.id, currencyCode: 'EGP' },
      [{ description: 'Service', quantity: '1', unitPrice: '100', taxRateBp: 1400 }],
      USER,
    ),
  );
  const issued = await repos(tenant, (tx) =>
    tx.financeInvoices.issue(draft.id, draft.version, {
      issuedBy: USER,
      issueDate: '2026-10-17',
      dueDate: '2026-11-17',
      customerName: 'Cairo Towers',
      customerAddress: {
        line1: '1 Road',
        line2: null,
        city: 'Cairo',
        region: null,
        postcode: null,
        countryCode: 'EG',
      },
      contactName: null,
      contactEmail: null,
      issuer: {
        name: 'Northwind',
        address: null,
        taxReference: null,
        paymentInstructions: null,
        footer: null,
      },
    }),
  );
  if (typeof issued === 'string') {
    throw new Error(issued);
  }
  return issued;
}

async function prepared(tenant: TenantFixture, invoice: Invoice, id: string) {
  return repos(tenant, (tx) =>
    tx.eta.createDocument({
      id,
      invoiceId: invoice.id,
      environment: 'preprod',
      internalId: 'INV-000001',
      unsignedJson: '{"internalID":"INV-000001","totalAmount":114}',
      canonicalSha256: DIGEST,
      exchangeRate: null,
      totalAmount: '114',
      currencyCode: 'EGP',
      by: USER,
    }),
  );
}

describe('settings', () => {
  it('start off, in PreProd, with no credentials, and refuse a stale version', async () => {
    const empty = await repos(northwind, (tx) => tx.eta.settings());
    expect(empty).toMatchObject({
      enabled: false,
      environment: 'preprod',
      hasCredentials: false,
      version: 0,
    });
    const input = {
      enabled: true,
      environment: 'preprod' as const,
      taxpayerId: '100000001',
      issuerName: 'Northwind',
      branchId: '0',
      activityCode: 'ACT',
      address: { ...EMPTY_ETA_ADDRESS, country: 'EG', street: '1 St' },
      intermediaryFor: null,
      documentTypeVersion: '1.0',
      defaultItem: { itemType: 'EGS' as const, itemCode: 'EG-1-SVC' },
    };
    const saved = await repos(northwind, (tx) => tx.eta.saveSettings(input, USER, 0));
    expect(saved).toMatchObject({ enabled: true, taxpayerId: '100000001', version: 1 });
    expect(await repos(northwind, (tx) => tx.eta.saveSettings(input, USER, 0))).toBeUndefined();
    expect(
      await repos(northwind, (tx) => tx.eta.saveSettings({ ...input, branchId: '1' }, USER, 1)),
    ).toMatchObject({ branchId: '1', version: 2 });
  });

  it('keep sealed credentials out of every read but one, and move their version', async () => {
    const saved = await repos(northwind, (tx) =>
      tx.eta.saveCredentials(
        { clientId: 'sealed-id', clientSecret: 'sealed-secret', hint: 'ab12' },
        USER,
      ),
    );
    expect(saved).toMatchObject({
      hasCredentials: true,
      credentialsHint: 'ab12',
      credentialsVersion: 1,
    });
    expect(JSON.stringify(saved)).not.toContain('sealed-');
    expect(await repos(northwind, (tx) => tx.eta.sealedCredentials())).toEqual({
      clientId: 'sealed-id',
      clientSecret: 'sealed-secret',
      version: 1,
    });
    const cleared = await repos(northwind, (tx) => tx.eta.clearCredentials(USER));
    expect(cleared).toMatchObject({ hasCredentials: false, credentialsVersion: 2 });
    expect(await repos(northwind, (tx) => tx.eta.sealedCredentials())).toBeUndefined();
  });

  it('refuse half a credential pair and badly shaped certificate pins', async () => {
    await expect(
      owner.query(`update eta_settings set client_id_sealed = 'x' where tenant_id = $1`, [
        northwind.id,
      ]),
    ).rejects.toMatchObject({
      constraint: 'eta_settings_credentials_paired',
    });
    await expect(
      repos(northwind, (tx) => tx.eta.setPinnedCertificates(['not-hex'], USER)),
    ).rejects.toMatchObject({
      constraint: 'eta_settings_pins_shape',
    });
    expect(
      (await repos(northwind, (tx) => tx.eta.setPinnedCertificates(['c'.repeat(64)], USER)))
        .pinnedCertificates,
    ).toEqual(['c'.repeat(64)]);
  });
});

describe('codes and mappings', () => {
  it('keeps receivers, unit types and tax mappings per company', async () => {
    const customer = await repos(northwind, (tx) =>
      tx.customers.create({ name: 'Receiver Co' }, USER),
    );
    await repos(northwind, (tx) =>
      tx.eta.saveReceiver({
        customerId: customer.id,
        receiverType: 'B',
        receiverId: '200000002',
        address: { ...EMPTY_ETA_ADDRESS, country: 'EG' },
        by: USER,
      }),
    );
    expect(await repos(northwind, (tx) => tx.eta.receiver(customer.id))).toMatchObject({
      receiverType: 'B',
      receiverId: '200000002',
    });
    await repos(northwind, (tx) =>
      tx.eta.replaceUnitTypes({ each: 'UNIT-EA', hour: 'UNIT-H' }, USER),
    );
    await repos(northwind, (tx) =>
      tx.eta.replaceTaxMappings([{ taxRateBp: 1400, taxType: 'TAX-A', subType: 'SUB-1' }], USER),
    );
    expect(await repos(northwind, (tx) => tx.eta.unitTypes())).toEqual({
      each: 'UNIT-EA',
      hour: 'UNIT-H',
    });
    expect(await repos(southgate, (tx) => tx.eta.unitTypes())).toEqual({});
    expect(await repos(southgate, (tx) => tx.eta.receivers())).toEqual([]);
    await expect(
      repos(northwind, (tx) => tx.eta.replaceUnitTypes({ furlong: 'X' }, USER)),
    ).rejects.toMatchObject({
      constraint: 'eta_unit_types_unit_known',
    });
  });
});

describe('ETA documents', () => {
  it('number each preparation, keep one live per invoice, and never change the snapshot', async () => {
    const invoice = await issuedInvoice(northwind);
    const first = await prepared(northwind, invoice, '10000000-0000-4000-8000-000000000001');
    expect(first).toMatchObject({ sequence: 1, state: 'ready', canonicalSha256: DIGEST });
    await expect(
      prepared(northwind, invoice, '10000000-0000-4000-8000-000000000002'),
    ).rejects.toMatchObject({
      constraint: 'eta_documents_one_live',
    });
    await repos(northwind, (tx) => tx.eta.transition(first.id, ['ready'], 'superseded'));
    const second = await prepared(northwind, invoice, '10000000-0000-4000-8000-000000000003');
    expect(second.sequence).toBe(2);

    await expect(
      owner.query(`update eta_documents set unsigned_json = '{}' where id = $1`, [second.id]),
    ).rejects.toMatchObject({
      constraint: 'eta_documents_snapshot_fixed',
    });
    await expect(
      owner.query(`update eta_documents set canonical_sha256 = $2 where id = $1`, [
        second.id,
        'f'.repeat(64),
      ]),
    ).rejects.toMatchObject({
      constraint: 'eta_documents_snapshot_fixed',
    });
  });

  it('cannot go past signing without a signed document, and keeps a signature once written', async () => {
    const invoice = await issuedInvoice(northwind);
    const document = await prepared(northwind, invoice, '10000000-0000-4000-8000-000000000010');
    await expect(
      repos(northwind, (tx) => tx.eta.transition(document.id, ['ready'], 'signed')),
    ).rejects.toMatchObject({
      constraint: 'eta_documents_signed_before_submission',
    });
    const signed = await repos(northwind, (tx) =>
      tx.eta.transition(document.id, ['ready'], 'signed', {
        signed: { json: '{"signed":true}', certificate: 'c'.repeat(64), by: USER, at: new Date() },
      }),
    );
    expect(signed?.state).toBe('signed');
    await expect(
      owner.query(`update eta_documents set signed_json = '{"other":1}' where id = $1`, [
        document.id,
      ]),
    ).rejects.toMatchObject({
      constraint: 'eta_documents_signature_fixed',
    });
    // A transition from a state it is not in does nothing.
    expect(
      await repos(northwind, (tx) =>
        tx.eta.transition(document.id, ['ready'], 'pending_signature'),
      ),
    ).toBeUndefined();
    expect(await repos(northwind, (tx) => tx.eta.documentTexts(document.id))).toEqual({
      unsigned: '{"internalID":"INV-000001","totalAmount":114}',
      signed: '{"signed":true}',
    });
  });

  it('records attempts without a document body', async () => {
    const invoice = await issuedInvoice(northwind);
    const document = await prepared(northwind, invoice, '10000000-0000-4000-8000-000000000020');
    await repos(northwind, (tx) =>
      tx.eta.recordAttempt({
        documentId: document.id,
        kind: 'submit',
        outcome: 'unknown',
        message: 'No answer in time',
        startedAt: new Date(),
      }),
    );
    expect(await repos(northwind, (tx) => tx.eta.attempts(document.id))).toEqual([
      expect.objectContaining({ kind: 'submit', outcome: 'unknown', message: 'No answer in time' }),
    ]);
  });
});

describe('signing requests', () => {
  it('are claimed by one agent, expire, and put the document back to ready', async () => {
    const invoice = await issuedInvoice(northwind);
    const document = await prepared(northwind, invoice, '10000000-0000-4000-8000-000000000030');
    await repos(northwind, (tx) => tx.eta.transition(document.id, ['ready'], 'pending_signature'));
    const now = new Date();
    const request = await repos(northwind, (tx) =>
      tx.eta.createSigningRequest({
        id: '20000000-0000-4000-8000-000000000001',
        documentId: document.id,
        digest: DIGEST,
        nonce: NONCE,
        expiresAt: new Date(now.getTime() + 60_000),
        by: USER,
      }),
    );
    await expect(
      repos(northwind, (tx) =>
        tx.eta.createSigningRequest({
          id: '20000000-0000-4000-8000-000000000002',
          documentId: document.id,
          digest: DIGEST,
          nonce: NONCE,
          expiresAt: new Date(now.getTime() + 60_000),
          by: USER,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'eta_signing_requests_one_open' });

    const OTHER = '00000000-0000-4000-8000-00000000e702';
    expect(
      await repos(northwind, (tx) => tx.eta.claimSigningRequest(request.id, USER, now)),
    ).toMatchObject({ status: 'claimed', claimedBy: USER });
    expect(
      await repos(northwind, (tx) => tx.eta.claimSigningRequest(request.id, OTHER, now)),
    ).toBeUndefined();
    expect(await repos(southgate, (tx) => tx.eta.signingRequest(request.id))).toBeUndefined();

    const later = new Date(now.getTime() + 120_000);
    expect(await repos(northwind, (tx) => tx.eta.signingQueue(later))).toEqual([]);
    expect(await repos(northwind, (tx) => tx.eta.signingRequest(request.id))).toMatchObject({
      status: 'expired',
    });
    expect(await repos(northwind, (tx) => tx.eta.document(document.id))).toMatchObject({
      state: 'ready',
    });
  });
});

describe('isolation', () => {
  it('lets the runtime role see only its own company’s ETA rows', async () => {
    const app = await connectAsApp();
    try {
      const seen = await asTenant(app, southgate.id, () =>
        app.query<{ n: number }>(
          `select (select count(*) from eta_settings)::int + (select count(*) from eta_documents)::int
                + (select count(*) from eta_receivers)::int + (select count(*) from eta_signing_requests)::int as n`,
        ),
      );
      expect(seen.rows[0]).toEqual({ n: 0 });
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`delete from eta_documents where tenant_id = $1`, [northwind.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () => app.query(`update eta_attempts set outcome = 'ok'`)),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await app.end();
    }
  });
});
