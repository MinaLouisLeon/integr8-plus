import { describe, expect, it } from 'vitest';
import { canonicalText } from './canonical.js';
import {
  buildInvoiceDocument,
  type EtaBuildInput,
  etaDateTime,
  invoiceReadiness,
  NotReadyError,
  withSignature,
} from './invoice.js';
import { parseJsonText, property, writeJsonText } from './json-text.js';
import { checkDocumentArithmetic } from './rules.js';

/** A made-up company and customer. Every code below is a placeholder, not an ETA code. */
function input(overrides: Partial<EtaBuildInput> = {}): EtaBuildInput {
  return {
    issuer: {
      type: 'B',
      id: '100000001',
      name: 'Nile Fire Safety',
      branchId: '0',
      activityCode: 'ACT-1',
      address: {
        country: 'EG',
        governate: 'Cairo',
        regionCity: 'Nasr City',
        street: '1 Test St',
        buildingNumber: '1',
      },
    },
    receiver: {
      type: 'B',
      id: '200000002',
      name: 'Cairo Towers',
      address: {
        country: 'EG',
        governate: 'Giza',
        regionCity: 'Dokki',
        street: '2 Test St',
        buildingNumber: '2',
      },
    },
    invoice: {
      internalId: 'INV-000001',
      status: 'issued',
      issuedAt: new Date('2026-10-17T09:30:15.250Z'),
      currencyCode: 'EGP',
      exchangeRate: null,
      total: '1111.5000',
      lines: [
        {
          position: 1,
          description: 'Fire extinguisher 6 kg',
          quantity: '3.0000',
          unit: 'each',
          unitPrice: '250.0000',
          discountBp: 1000,
          taxRateBp: 1400,
          internalCode: 'EXT-6',
          itemCode: { itemType: 'EGS', itemCode: 'EG-100000001-EXT6' },
        },
        {
          position: 2,
          description: 'Labour',
          quantity: '1.5000',
          unit: 'hour',
          unitPrice: '200.0000',
          discountBp: 0,
          taxRateBp: 1400,
          internalCode: null,
          itemCode: null,
        },
      ],
    },
    mappings: {
      unitTypes: { each: 'UNIT-EA', hour: 'UNIT-H' },
      taxes: { 1400: { taxType: 'TAX-A', subType: 'SUB-1' } },
      defaultItemCode: { itemType: 'EGS', itemCode: 'EG-100000001-SERVICE' },
    },
    ...overrides,
  };
}

describe('invoice readiness', () => {
  it('finds nothing wrong with a complete invoice', () => {
    expect(invoiceReadiness(input())).toEqual([]);
  });

  it('names everything that is missing', () => {
    const codes = invoiceReadiness(
      input({
        issuer: null,
        receiver: { type: 'B', id: null, name: 'X', address: null },
        invoice: { ...input().invoice, status: 'draft', issuedAt: null, currencyCode: 'USD' },
        mappings: { unitTypes: {}, taxes: {}, defaultItemCode: null },
      }),
    ).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'invoice_not_issued',
        'issuer_missing',
        'receiver_id_missing',
        'receiver_address_missing',
        'exchange_rate_missing',
        'line_item_code_missing',
        'line_unit_unmapped',
        'line_tax_unmapped',
      ]),
    );
  });

  it('refuses text whose signed form is not confirmed (quotes, backslashes, control characters)', () => {
    const base = input();
    const issues = invoiceReadiness({
      ...base,
      invoice: {
        ...base.invoice,
        lines: [{ ...base.invoice.lines[0]!, description: 'Hose 1/2" fitting' }],
      },
    });
    expect(issues).toContainEqual({
      code: 'text_unsupported',
      severity: 'error',
      path: 'lines[0].description',
    });
  });

  it('warns when the ETA total differs from the invoice total', () => {
    const issues = invoiceReadiness(input({ invoice: { ...input().invoice, total: '1111.5100' } }));
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'total_differs',
        severity: 'warning',
        params: { invoice: '1111.51', eta: '1111.5' },
      }),
    ]);
  });

  it('does not build a document while there are errors', () => {
    expect(() => buildInvoiceDocument(input({ issuer: null }))).toThrow(NotReadyError);
  });
});

describe('the ETA invoice document', () => {
  it('computes every amount exactly and writes it as text', () => {
    const { document, computed } = buildInvoiceDocument(input());
    // Line 1: 3 × 250 = 750; 10% discount 75; net 675; 14% = 94.5; total 769.5.
    // Line 2: 1.5 × 200 = 300; net 300; 14% = 42; total 342.
    expect(writeJsonText(property(document, 'totalSalesAmount')!)).toBe('1050');
    expect(writeJsonText(property(document, 'totalDiscountAmount')!)).toBe('75');
    expect(writeJsonText(property(document, 'netAmount')!)).toBe('975');
    expect(writeJsonText(property(document, 'totalAmount')!)).toBe('1111.5');
    expect(computed.taxTotals.map((entry) => entry.taxType)).toEqual(['TAX-A']);
    expect(checkDocumentArithmetic(document)).toEqual([]);
  });

  it('is deterministic, and its text parses back to the same canonical form', () => {
    const one = writeJsonText(buildInvoiceDocument(input()).document);
    const two = writeJsonText(buildInvoiceDocument(input()).document);
    expect(one).toBe(two);
    expect(canonicalText(parseJsonText(one))).toBe(
      canonicalText(buildInvoiceDocument(input()).document),
    );
    expect(one).toContain('"dateTimeIssued":"2026-10-17T09:30:15Z"');
    expect(one).toContain('"internalID":"INV-000001"');
    expect(one).toContain('"itemCode":"EG-100000001-SERVICE"');
    expect(one).not.toContain('signatures');
  });

  it('writes a foreign-currency line with the amount sold and the rate', () => {
    const { document } = buildInvoiceDocument(
      input({
        invoice: { ...input().invoice, currencyCode: 'USD', exchangeRate: '48.25', total: '0' },
      }),
    );
    const text = writeJsonText(document);
    expect(text).toContain(
      '"unitValue":{"currencySold":"USD","amountSold":250,"amountEGP":12062.5,"currencyExchangeRate":48.25}',
    );
    expect(checkDocumentArithmetic(document)).toEqual([]);
  });

  it('leaves out blank optional fields rather than sending empty strings', () => {
    const text = writeJsonText(buildInvoiceDocument(input()).document);
    expect(text).not.toContain('"postalCode"');
    expect(text).not.toContain('""');
  });

  it('adds the signature as type I and nothing else', () => {
    const { document } = buildInvoiceDocument(input());
    const signed = withSignature(document, 'QUJD');
    expect(
      writeJsonText(signed).endsWith(',"signatures":[{"signatureType":"I","value":"QUJD"}]}'),
    ).toBe(true);
    expect(canonicalText(signed)).toBe(canonicalText(document));
    expect(() => withSignature(document, 'not base64!')).toThrow(TypeError);
  });

  it('formats issue times in UTC to the second', () => {
    expect(etaDateTime(new Date('2026-01-02T03:04:05.999+02:00'))).toBe('2026-01-02T01:04:05Z');
  });
});

describe('the arithmetic check', () => {
  it('finds a changed amount', () => {
    const text = writeJsonText(buildInvoiceDocument(input()).document).replace(
      '"totalAmount":1111.5',
      '"totalAmount":1111.6',
    );
    expect(checkDocumentArithmetic(parseJsonText(text))).toEqual([
      { path: 'totalAmount', expected: '1111.5', actual: '1111.6' },
    ]);
  });

  it('finds a wrong tax line', () => {
    const text = writeJsonText(buildInvoiceDocument(input()).document).replace(
      '"amount":94.5',
      '"amount":94.6',
    );
    expect(checkDocumentArithmetic(parseJsonText(text)).map((issue) => issue.path)).toContain(
      'invoiceLines[0].taxableItems[0].amount',
    );
  });
});
