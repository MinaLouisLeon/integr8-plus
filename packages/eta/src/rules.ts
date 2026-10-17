import {
  add,
  compare,
  type Decimal,
  formatDecimal,
  isDecimalText,
  mul,
  parseDecimal,
  round,
  shift,
  sub,
  ZERO,
} from './decimal.js';
import { type JsonText, property, stringValue } from './json-text.js';

/**
 * The arithmetic of a built document, checked again from its own text.
 *
 * SPEC-UNVERIFIED(doc-arithmetic): the rules are the recalled ETA validation
 * rules for documents with taxable items expressed as rates of the net total
 * and no taxable fees, value difference or items discount (what `invoice.ts`
 * produces). A document that uses those other fields is not judged here; the
 * ETA's own validation is.
 */

export interface RuleIssue {
  path: string;
  expected: string;
  actual: string;
}

function decimalAt(value: JsonText | undefined): Decimal | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = value.kind === 'number' ? value.raw : stringValue(value);
  return raw !== undefined && isDecimalText(raw) ? parseDecimal(raw) : undefined;
}

function check(
  issues: RuleIssue[],
  path: string,
  expected: Decimal,
  actual: Decimal | undefined,
): void {
  if (actual === undefined || compare(round(expected), round(actual)) !== 0) {
    issues.push({
      path,
      expected: formatDecimal(expected),
      actual: actual === undefined ? 'missing' : formatDecimal(actual),
    });
  }
}

export function checkDocumentArithmetic(document: JsonText): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const lines = property(document, 'invoiceLines');
  if (lines?.kind !== 'array') {
    return [{ path: 'invoiceLines', expected: 'a list', actual: 'missing' }];
  }
  let sales = ZERO;
  let discounts = ZERO;
  let net = ZERO;
  let total = ZERO;
  const taxTotals = new Map<string, Decimal>();

  lines.items.forEach((line, index) => {
    const path = `invoiceLines[${String(index)}]`;
    const quantity = decimalAt(property(line, 'quantity')) ?? ZERO;
    const amountEGP = decimalAt(property(property(line, 'unitValue'), 'amountEGP')) ?? ZERO;
    const salesTotal = round(mul(quantity, amountEGP));
    check(issues, `${path}.salesTotal`, salesTotal, decimalAt(property(line, 'salesTotal')));

    const discount = property(line, 'discount');
    const discountRate = decimalAt(property(discount, 'rate')) ?? ZERO;
    const discountAmount = round(mul(salesTotal, shift(discountRate, 2)));
    check(
      issues,
      `${path}.discount.amount`,
      discountAmount,
      decimalAt(property(discount, 'amount')),
    );

    const netTotal = sub(salesTotal, discountAmount);
    check(issues, `${path}.netTotal`, netTotal, decimalAt(property(line, 'netTotal')));

    let lineTax = ZERO;
    const taxable = property(line, 'taxableItems');
    if (taxable?.kind === 'array') {
      taxable.items.forEach((item, itemIndex) => {
        const rate = decimalAt(property(item, 'rate')) ?? ZERO;
        const amount = round(mul(netTotal, shift(rate, 2)));
        check(
          issues,
          `${path}.taxableItems[${String(itemIndex)}].amount`,
          amount,
          decimalAt(property(item, 'amount')),
        );
        lineTax = add(lineTax, amount);
        const taxType = stringValue(property(item, 'taxType')) ?? '';
        taxTotals.set(taxType, add(taxTotals.get(taxType) ?? ZERO, amount));
      });
    }
    const lineTotal = add(netTotal, lineTax);
    check(issues, `${path}.total`, lineTotal, decimalAt(property(line, 'total')));

    sales = add(sales, salesTotal);
    discounts = add(discounts, discountAmount);
    net = add(net, netTotal);
    total = add(total, lineTotal);
  });

  check(issues, 'totalSalesAmount', sales, decimalAt(property(document, 'totalSalesAmount')));
  check(
    issues,
    'totalDiscountAmount',
    discounts,
    decimalAt(property(document, 'totalDiscountAmount')),
  );
  check(issues, 'netAmount', net, decimalAt(property(document, 'netAmount')));
  const extra = decimalAt(property(document, 'extraDiscountAmount')) ?? ZERO;
  check(issues, 'totalAmount', sub(total, extra), decimalAt(property(document, 'totalAmount')));

  const totals = property(document, 'taxTotals');
  for (const [taxType, amount] of taxTotals) {
    const entry =
      totals?.kind === 'array'
        ? totals.items.find((item) => stringValue(property(item, 'taxType')) === taxType)
        : undefined;
    check(issues, `taxTotals[${taxType}]`, amount, decimalAt(property(entry, 'amount')));
  }
  return issues;
}
