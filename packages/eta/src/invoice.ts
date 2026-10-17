import {
  add,
  compare,
  type Decimal,
  ETA_SCALE,
  formatDecimal,
  fractionFromBasisPoints,
  isDecimalText,
  mul,
  parseDecimal,
  percentFromBasisPoints,
  round,
  sub,
  sum,
  ZERO,
} from './decimal.js';
import { arr, type JsonText, num, obj, str } from './json-text.js';
import type { EtaItemType, EtaReceiverType } from '@integr8/core';

/**
 * An Integr8 invoice as an ETA invoice document (type `i`, version 1.0).
 *
 * SPEC-UNVERIFIED(doc-fields): the property names and nesting below are
 * written from memory of the SDK's invoice v1.0 page. They are not confirmed
 * against the authoritative schema, which is why submission requires that
 * schema (PLAN §7) and validates every document against it first.
 *
 * SPEC-UNVERIFIED(doc-arithmetic): line and document amounts follow the
 * recalled validation rules, for the one tax this release supports (VAT, tax
 * type set per company): salesTotal = quantity × amountEGP; discount = rate of
 * salesTotal; netTotal = salesTotal − discount; tax = rate of netTotal;
 * total = netTotal + tax. No items discount, value difference or taxable fees
 * are produced. `rules.ts` checks a built document against the same rules.
 *
 * Every code (tax type and subtype, unit type, item code) is entered by the
 * company from the ETA's code tables; nothing here guesses one.
 */

export const ETA_DOCUMENT_TYPE_INVOICE = 'I';
export const ETA_DEFAULT_VERSION = '1.0';

export interface EtaAddress {
  country: string;
  governate: string;
  regionCity: string;
  street: string;
  buildingNumber: string;
  postalCode?: string | null;
  floor?: string | null;
  room?: string | null;
  landmark?: string | null;
  additionalInformation?: string | null;
}

export interface EtaIssuerProfile {
  /** SPEC-UNVERIFIED(receiver-rules): `B` for a registered business. */
  type: string;
  /** The taxpayer's registration number (RIN). */
  id: string;
  name: string;
  branchId: string;
  activityCode: string;
  address: EtaAddress;
}

export interface EtaReceiverProfile {
  type: EtaReceiverType;
  /** Registration number (B), national id (P) or passport/foreign id (F). */
  id: string | null;
  name: string;
  address: EtaAddress | null;
}

export interface EtaItemCode {
  itemType: EtaItemType;
  itemCode: string;
}

export interface EtaTaxMapping {
  taxType: string;
  subType: string;
}

export interface EtaInvoiceLine {
  position: number;
  description: string;
  /** Decimal text, as stored. */
  quantity: string;
  unit: string;
  /** Decimal text, in the invoice's currency. */
  unitPrice: string;
  discountBp: number;
  taxRateBp: number;
  /** The SKU or the company's own code for the line, if any. */
  internalCode: string | null;
  /** The line's own item code, if its item has one; else the company default is used. */
  itemCode: EtaItemCode | null;
}

export interface EtaInvoiceSource {
  /** Shown to people and sent as `internalID`: `INV-000123`. */
  internalId: string;
  status: 'draft' | 'issued' | 'void';
  issuedAt: Date | null;
  currencyCode: string;
  /** EGP per one unit of the invoice's currency; required unless EGP. */
  exchangeRate: string | null;
  /** The invoice's own total as Integr8 computed it (4 places), for comparison. */
  total: string;
  lines: readonly EtaInvoiceLine[];
}

export interface EtaMappings {
  /** Integr8 unit → ETA unit type code. */
  unitTypes: Readonly<Record<string, string>>;
  /** Tax rate in basis points → ETA tax type and subtype. */
  taxes: Readonly<Record<number, EtaTaxMapping>>;
  /** For lines with no item code of their own. */
  defaultItemCode: EtaItemCode | null;
}

export interface EtaBuildInput {
  issuer: EtaIssuerProfile | null;
  receiver: EtaReceiverProfile | null;
  invoice: EtaInvoiceSource;
  mappings: EtaMappings;
  documentTypeVersion?: string;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type ReadinessCode =
  | 'invoice_not_issued'
  | 'issuer_missing'
  | 'issuer_field_missing'
  | 'receiver_missing'
  | 'receiver_id_missing'
  | 'receiver_address_missing'
  | 'receiver_field_missing'
  | 'line_item_code_missing'
  | 'line_unit_unmapped'
  | 'line_tax_unmapped'
  | 'exchange_rate_missing'
  | 'exchange_rate_invalid'
  | 'text_unsupported'
  | 'amount_invalid'
  | 'total_differs';

export interface ReadinessIssue {
  code: ReadinessCode;
  severity: 'error' | 'warning';
  /** Where: `issuer.address.street`, `lines[2].unit`… */
  path: string;
  /** Values the message names: the unit, the rate, the two totals. */
  params?: Record<string, string>;
}

/** Characters whose canonical form is not confirmed (SPEC-UNVERIFIED canonical-escapes). */
function unsupportedText(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '"' || char === '\\' || code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const REQUIRED_ADDRESS: readonly (keyof EtaAddress)[] = [
  'country',
  'governate',
  'regionCity',
  'street',
  'buildingNumber',
];

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function checkText(issues: ReadinessIssue[], path: string, value: string | null | undefined): void {
  if (value !== null && value !== undefined && unsupportedText(value)) {
    issues.push({ code: 'text_unsupported', severity: 'error', path });
  }
}

function checkAddress(
  issues: ReadinessIssue[],
  path: string,
  address: EtaAddress,
  missing: 'issuer_field_missing' | 'receiver_field_missing',
): void {
  for (const field of REQUIRED_ADDRESS) {
    if (blank(address[field])) {
      issues.push({ code: missing, severity: 'error', path: `${path}.${field}` });
    }
  }
  for (const [field, value] of Object.entries(address)) {
    checkText(issues, `${path}.${field}`, value as string | null | undefined);
  }
}

/** What stops this invoice becoming an ETA document, and what only deserves a look. */
export function invoiceReadiness(input: EtaBuildInput): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const { issuer, receiver, invoice, mappings } = input;

  if (invoice.status !== 'issued' || invoice.issuedAt === null) {
    issues.push({ code: 'invoice_not_issued', severity: 'error', path: 'invoice.status' });
  }

  if (issuer === null) {
    issues.push({ code: 'issuer_missing', severity: 'error', path: 'issuer' });
  } else {
    for (const field of ['id', 'name', 'branchId', 'activityCode', 'type'] as const) {
      if (blank(issuer[field])) {
        issues.push({ code: 'issuer_field_missing', severity: 'error', path: `issuer.${field}` });
      }
      checkText(issues, `issuer.${field}`, issuer[field]);
    }
    checkAddress(issues, 'issuer.address', issuer.address, 'issuer_field_missing');
  }

  if (receiver === null) {
    issues.push({ code: 'receiver_missing', severity: 'error', path: 'receiver' });
  } else {
    checkText(issues, 'receiver.name', receiver.name);
    checkText(issues, 'receiver.id', receiver.id);
    // SPEC-UNVERIFIED(receiver-rules): a business receiver always needs its
    // registration number and address; for a person or a foreigner the ETA's
    // thresholds decide, and the authoritative schema and the ETA's own
    // validation are the judges.
    if (receiver.type === 'B') {
      if (blank(receiver.id)) {
        issues.push({ code: 'receiver_id_missing', severity: 'error', path: 'receiver.id' });
      }
      if (receiver.address === null) {
        issues.push({
          code: 'receiver_address_missing',
          severity: 'error',
          path: 'receiver.address',
        });
      }
    }
    if (receiver.address !== null) {
      checkAddress(issues, 'receiver.address', receiver.address, 'receiver_field_missing');
    }
  }

  if (invoice.currencyCode !== 'EGP') {
    if (invoice.exchangeRate === null) {
      issues.push({
        code: 'exchange_rate_missing',
        severity: 'error',
        path: 'invoice.exchangeRate',
        params: { currency: invoice.currencyCode },
      });
    } else if (!isDecimalText(invoice.exchangeRate) || !(Number(invoice.exchangeRate) > 0)) {
      issues.push({
        code: 'exchange_rate_invalid',
        severity: 'error',
        path: 'invoice.exchangeRate',
      });
    }
  }

  invoice.lines.forEach((line, index) => {
    const path = `lines[${String(index)}]`;
    checkText(issues, `${path}.description`, line.description);
    checkText(issues, `${path}.internalCode`, line.internalCode);
    if (line.itemCode === null && mappings.defaultItemCode === null) {
      issues.push({ code: 'line_item_code_missing', severity: 'error', path: `${path}.itemCode` });
    }
    checkText(issues, `${path}.itemCode`, (line.itemCode ?? mappings.defaultItemCode)?.itemCode);
    const unitType = mappings.unitTypes[line.unit];
    if (unitType === undefined || blank(unitType)) {
      issues.push({
        code: 'line_unit_unmapped',
        severity: 'error',
        path: `${path}.unit`,
        params: { unit: line.unit },
      });
    }
    if (mappings.taxes[line.taxRateBp] === undefined) {
      issues.push({
        code: 'line_tax_unmapped',
        severity: 'error',
        path: `${path}.taxRateBp`,
        params: { rate: formatDecimal(percentFromBasisPoints(line.taxRateBp)) },
      });
    }
    if (!isDecimalText(line.quantity) || !isDecimalText(line.unitPrice)) {
      issues.push({ code: 'amount_invalid', severity: 'error', path });
    }
  });

  if (!issues.some((issue) => issue.severity === 'error')) {
    const built = computeInvoice(input);
    const ours = round(parseDecimal(invoice.total), ETA_SCALE);
    if (compare(built.totalAmount, ours) !== 0) {
      issues.push({
        code: 'total_differs',
        severity: 'warning',
        path: 'invoice.total',
        params: { invoice: formatDecimal(ours), eta: formatDecimal(built.totalAmount) },
      });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export interface ComputedLine {
  line: EtaInvoiceLine;
  amountSold: Decimal;
  amountEGP: Decimal;
  salesTotal: Decimal;
  discountRate: Decimal;
  discountAmount: Decimal;
  netTotal: Decimal;
  taxRate: Decimal;
  taxAmount: Decimal;
  total: Decimal;
}

export interface ComputedInvoice {
  lines: ComputedLine[];
  totalSalesAmount: Decimal;
  totalDiscountAmount: Decimal;
  netAmount: Decimal;
  /** In first-seen order of tax type. */
  taxTotals: { taxType: string; amount: Decimal }[];
  totalAmount: Decimal;
}

/** The amounts, exactly. Assumes `invoiceReadiness` found no errors. */
export function computeInvoice(input: EtaBuildInput): ComputedInvoice {
  const { invoice, mappings } = input;
  const rate =
    invoice.currencyCode === 'EGP' || invoice.exchangeRate === null
      ? null
      : parseDecimal(invoice.exchangeRate);
  const lines = invoice.lines.map((line): ComputedLine => {
    const amountSold = parseDecimal(line.unitPrice);
    const amountEGP = rate === null ? round(amountSold) : round(mul(amountSold, rate));
    const salesTotal = round(mul(parseDecimal(line.quantity), amountEGP));
    const discountAmount = round(mul(salesTotal, fractionFromBasisPoints(line.discountBp)));
    const netTotal = sub(salesTotal, discountAmount);
    const taxAmount = round(mul(netTotal, fractionFromBasisPoints(line.taxRateBp)));
    return {
      line,
      amountSold,
      amountEGP,
      salesTotal,
      discountRate: percentFromBasisPoints(line.discountBp),
      discountAmount,
      netTotal,
      taxRate: percentFromBasisPoints(line.taxRateBp),
      taxAmount,
      total: add(netTotal, taxAmount),
    };
  });
  const taxTotals: { taxType: string; amount: Decimal }[] = [];
  for (const computed of lines) {
    const taxType = mappings.taxes[computed.line.taxRateBp]?.taxType ?? '';
    const existing = taxTotals.find((entry) => entry.taxType === taxType);
    if (existing === undefined) {
      taxTotals.push({ taxType, amount: computed.taxAmount });
    } else {
      existing.amount = add(existing.amount, computed.taxAmount);
    }
  }
  return {
    lines,
    totalSalesAmount: sum(lines.map((line) => line.salesTotal)),
    totalDiscountAmount: sum(lines.map((line) => line.discountAmount)),
    netAmount: sum(lines.map((line) => line.netTotal)),
    taxTotals,
    totalAmount: sum(lines.map((line) => line.total)),
  };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const amount = (value: Decimal) => num(formatDecimal(value));
const text = (value: string | null | undefined) =>
  value === null || value === undefined || value.trim() === '' ? undefined : str(value.trim());

function address(value: EtaAddress, branchId?: string): JsonText {
  return obj([
    // SPEC-UNVERIFIED(doc-fields): `branchID`, with a capital ID, on the issuer only.
    ['branchID', branchId === undefined ? undefined : str(branchId)],
    ['country', text(value.country)],
    ['governate', text(value.governate)],
    ['regionCity', text(value.regionCity)],
    ['street', text(value.street)],
    ['buildingNumber', text(value.buildingNumber)],
    ['postalCode', text(value.postalCode)],
    ['floor', text(value.floor)],
    ['room', text(value.room)],
    ['landmark', text(value.landmark)],
    ['additionalInformation', text(value.additionalInformation)],
  ]);
}

/** UTC to the second: `2026-10-17T09:30:00Z`. */
export function etaDateTime(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

export class NotReadyError extends Error {
  constructor(readonly issues: ReadinessIssue[]) {
    super(`The invoice is not ready: ${issues.map((issue) => issue.code).join(', ')}`);
    this.name = 'NotReadyError';
  }
}

export interface BuiltDocument {
  document: JsonText;
  computed: ComputedInvoice;
}

/** The unsigned document. Throws `NotReadyError` while readiness has errors. */
export function buildInvoiceDocument(input: EtaBuildInput): BuiltDocument {
  const errors = invoiceReadiness(input).filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new NotReadyError(errors);
  }
  const issuer = input.issuer!;
  const receiver = input.receiver!;
  const { invoice, mappings } = input;
  const computed = computeInvoice(input);
  const foreign = invoice.currencyCode !== 'EGP';

  const lines = computed.lines.map((entry) => {
    const code = entry.line.itemCode ?? mappings.defaultItemCode!;
    const tax = mappings.taxes[entry.line.taxRateBp]!;
    return obj([
      ['description', str(entry.line.description.trim())],
      ['itemType', str(code.itemType)],
      ['itemCode', str(code.itemCode)],
      ['unitType', str(mappings.unitTypes[entry.line.unit]!)],
      ['quantity', amount(parseDecimal(entry.line.quantity))],
      ['internalCode', text(entry.line.internalCode)],
      ['salesTotal', amount(entry.salesTotal)],
      ['total', amount(entry.total)],
      ['valueDifference', amount(ZERO)],
      ['totalTaxableFees', amount(ZERO)],
      ['netTotal', amount(entry.netTotal)],
      ['itemsDiscount', amount(ZERO)],
      [
        'unitValue',
        obj([
          ['currencySold', str(invoice.currencyCode)],
          ['amountSold', foreign ? amount(entry.amountSold) : undefined],
          ['amountEGP', amount(entry.amountEGP)],
          [
            'currencyExchangeRate',
            foreign ? amount(parseDecimal(invoice.exchangeRate!)) : undefined,
          ],
        ]),
      ],
      [
        'discount',
        obj([
          ['rate', amount(entry.discountRate)],
          ['amount', amount(entry.discountAmount)],
        ]),
      ],
      [
        'taxableItems',
        arr([
          obj([
            ['taxType', str(tax.taxType)],
            ['amount', amount(entry.taxAmount)],
            ['subType', str(tax.subType)],
            ['rate', amount(entry.taxRate)],
          ]),
        ]),
      ],
    ]);
  });

  const document = obj([
    [
      'issuer',
      obj([
        ['address', address(issuer.address, issuer.branchId)],
        ['type', str(issuer.type)],
        ['id', str(issuer.id)],
        ['name', str(issuer.name)],
      ]),
    ],
    [
      'receiver',
      obj([
        ['address', receiver.address === null ? undefined : address(receiver.address)],
        ['type', str(receiver.type)],
        ['id', text(receiver.id)],
        ['name', str(receiver.name)],
      ]),
    ],
    // SPEC-UNVERIFIED(doc-type): the README names type `i`; the case of the value is recalled.
    ['documentType', str(ETA_DOCUMENT_TYPE_INVOICE)],
    ['documentTypeVersion', str(input.documentTypeVersion ?? ETA_DEFAULT_VERSION)],
    ['dateTimeIssued', str(etaDateTime(invoice.issuedAt!))],
    ['taxpayerActivityCode', str(issuer.activityCode)],
    ['internalID', str(invoice.internalId)],
    ['invoiceLines', arr(lines)],
    ['totalDiscountAmount', amount(computed.totalDiscountAmount)],
    ['totalSalesAmount', amount(computed.totalSalesAmount)],
    ['netAmount', amount(computed.netAmount)],
    [
      'taxTotals',
      arr(
        computed.taxTotals.map((entry) =>
          obj([
            ['taxType', str(entry.taxType)],
            ['amount', amount(entry.amount)],
          ]),
        ),
      ),
    ],
    ['totalAmount', amount(computed.totalAmount)],
    ['extraDiscountAmount', amount(ZERO)],
    ['totalItemsDiscountAmount', amount(ZERO)],
  ]);
  return { document, computed };
}

/** The signed document: the unsigned one with its `signatures` (type `I`). */
export function withSignature(document: JsonText, cmsBase64: string): JsonText {
  if (document.kind !== 'object') {
    throw new TypeError('A document is an object');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(cmsBase64)) {
    throw new TypeError('The signature is not Base64');
  }
  return {
    kind: 'object',
    entries: [
      ...document.entries.filter((entry) => entry.name !== 'signatures'),
      {
        name: 'signatures',
        value: arr([
          obj([
            ['signatureType', str('I')],
            ['value', str(cmsBase64)],
          ]),
        ]),
      },
    ],
  };
}
