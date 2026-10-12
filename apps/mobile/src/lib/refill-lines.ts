import { isPositiveDecimal, normaliseDecimal } from './decimal';

/**
 * The lines of a van refill request as the engineer edits them (ADR-0012):
 * the van's proposal to start from, quantities changed, lines removed, items
 * added from the catalogue or the van's own stock. Each item goes on the
 * request once — the server refuses a repeat (`item_repeated`) — so adding
 * an item already there keeps the line it has. Pure, so it is tested here.
 */

export interface RefillItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
}

export interface RefillLine {
  item: RefillItem;
  /** As typed: checked before sending. */
  quantity: string;
  /** From the van's proposal: what it holds and the level it keeps. */
  proposed?: { onHand: string; minimum: string; requested: string } | undefined;
}

export function fromProposal(
  lines: readonly {
    item: RefillItem;
    onHand: string;
    minimum: string;
    requested: string;
    quantity: string;
  }[],
): RefillLine[] {
  return lines.map((line) => ({
    item: line.item,
    quantity: line.quantity,
    proposed: { onHand: line.onHand, minimum: line.minimum, requested: line.requested },
  }));
}

/** Adds an item with a quantity of one, unless it is on the request already. */
export function addItem(lines: readonly RefillLine[], item: RefillItem): RefillLine[] {
  return lines.some((line) => line.item.id === item.id)
    ? [...lines]
    : [...lines, { item, quantity: '1' }];
}

export function setQuantity(
  lines: readonly RefillLine[],
  itemId: string,
  quantity: string,
): RefillLine[] {
  return lines.map((line) => (line.item.id === itemId ? { ...line, quantity } : line));
}

export function removeItem(lines: readonly RefillLine[], itemId: string): RefillLine[] {
  return lines.filter((line) => line.item.id !== itemId);
}

export type RefillCheck =
  | { ok: true; lines: { itemId: string; quantity: string }[] }
  | { ok: false; reason: 'empty' | 'invalid_quantity'; itemIds: string[] };

/** What goes to `POST /v1/inventory/van-requests`, or why it cannot go yet. */
export function requestLines(lines: readonly RefillLine[]): RefillCheck {
  if (lines.length === 0) {
    return { ok: false, reason: 'empty', itemIds: [] };
  }
  const invalid = lines.filter((line) => !isPositiveDecimal(line.quantity));
  if (invalid.length > 0) {
    return { ok: false, reason: 'invalid_quantity', itemIds: invalid.map((line) => line.item.id) };
  }
  return {
    ok: true,
    lines: lines.map((line) => ({
      itemId: line.item.id,
      quantity: normaliseDecimal(line.quantity),
    })),
  };
}
