import {
  addDecimals,
  compareDecimals,
  isDecimal,
  normaliseDecimal,
  subtractDecimals,
} from './decimal';

/**
 * Counting goods off a delivery against a purchase order (ADR-0012), before
 * the receipt is recorded: each scan of an item adds one to its line, a
 * quantity can be typed instead, and nothing is counted past what the order
 * still has to receive — the server would refuse the receipt (`over_received`).
 * Pure, so the counting is tested without a camera.
 */

export interface TallyLine {
  id: string;
  item: { id: string; name: string };
  quantityOrdered: string;
  quantityReceived: string;
}

/** What has been counted now, by order line id: decimal strings. */
export type Tally = Readonly<Record<string, string>>;

export type ScanOutcome =
  | { outcome: 'added'; lineId: string; tally: Tally }
  /** The item is on the order, but every line of it is already counted in full. */
  | { outcome: 'over'; lineId: string; tally: Tally }
  | { outcome: 'not_on_order'; tally: Tally };

/** What the order still has to receive on a line, never below zero. */
export function outstanding(line: TallyLine): string {
  return subtractDecimals(line.quantityOrdered, line.quantityReceived);
}

export function counted(tally: Tally, lineId: string): string {
  return tally[lineId] ?? '0';
}

/**
 * One scan of `itemId`: one more on the first of its lines with room left.
 * An item on two lines fills the first before the second.
 */
export function scan(lines: readonly TallyLine[], tally: Tally, itemId: string): ScanOutcome {
  const candidates = lines.filter((line) => line.item.id === itemId);
  if (candidates.length === 0) {
    return { outcome: 'not_on_order', tally };
  }
  for (const line of candidates) {
    const next = addDecimals(counted(tally, line.id), '1');
    if (compareDecimals(next, outstanding(line)) <= 0) {
      return { outcome: 'added', lineId: line.id, tally: { ...tally, [line.id]: next } };
    }
  }
  return { outcome: 'over', lineId: candidates[0]!.id, tally };
}

export type TypedOutcome =
  | { outcome: 'set'; tally: Tally }
  | { outcome: 'invalid' }
  | { outcome: 'over'; outstanding: string };

/** A quantity typed for a line: zero clears it; more than is left is refused. */
export function setCount(
  lines: readonly TallyLine[],
  tally: Tally,
  lineId: string,
  typed: string,
): TypedOutcome {
  const line = lines.find((candidate) => candidate.id === lineId);
  if (line === undefined || !isDecimal(typed)) {
    return { outcome: 'invalid' };
  }
  const quantity = normaliseDecimal(typed);
  if (compareDecimals(quantity, outstanding(line)) > 0) {
    return { outcome: 'over', outstanding: outstanding(line) };
  }
  const { [lineId]: _cleared, ...rest } = tally;
  return { outcome: 'set', tally: quantity === '0' ? rest : { ...rest, [lineId]: quantity } };
}

/** The receipt's lines, in the order's order: every line with something counted. */
export function receiptLines(
  lines: readonly TallyLine[],
  tally: Tally,
): { orderLineId: string; quantity: string }[] {
  return lines.flatMap((line) => {
    const quantity = counted(tally, line.id);
    return compareDecimals(quantity, '0') > 0 ? [{ orderLineId: line.id, quantity }] : [];
  });
}
