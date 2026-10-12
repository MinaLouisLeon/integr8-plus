import { z } from 'zod';
import { fromUnits, toUnits } from './ledger.js';

/**
 * Bills of materials, assembly and disassembly orders, and planning (seventh
 * round; ADR-0011). Quantities and costs are decimal strings worked in
 * ten-thousandths (BigInt) and rounded half up to four places, as the stock
 * ledger keeps them.
 */

export const ASSEMBLY_ORDER_STATUSES = ['draft', 'completed', 'cancelled'] as const;
export const assemblyOrderStatusSchema = z.enum(ASSEMBLY_ORDER_STATUSES);
export type AssemblyOrderStatus = z.infer<typeof assemblyOrderStatusSchema>;

/** Build an item from its parts, or take it apart into them. */
export const ASSEMBLY_DIRECTIONS = ['assemble', 'disassemble'] as const;
export const assemblyDirectionSchema = z.enum(ASSEMBLY_DIRECTIONS);
export type AssemblyDirection = z.infer<typeof assemblyDirectionSchema>;

/** `AO-000123`. */
export const formatAssemblyReference = (reference: number) =>
  `AO-${String(reference).padStart(6, '0')}`;

/** `AO-000123`, `ao-123` or `123` to 123; undefined for anything else. */
export function parseAssemblyReference(text: string): number | undefined {
  const match = /^(?:ao-?)?0*(\d{1,9})$/iu.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

const SCALE = 10_000n;

/** `a × b`, both with up to four places, rounded half up to four. */
export function multiplyDecimal(a: string, b: string): string {
  const product = toUnits(a) * toUnits(b);
  const negative = product < 0n;
  const absolute = negative ? -product : product;
  const rounded = (absolute + SCALE / 2n) / SCALE;
  return fromUnits(negative ? -rounded : rounded);
}

export interface BomComponent {
  itemId: string;
  /** Per unit of what is built. */
  quantity: string;
}

/** What a run of `quantity` units takes of each component. */
export function componentNeeds(
  components: readonly BomComponent[],
  quantity: string,
): { itemId: string; quantity: string }[] {
  return components.map((component) => ({
    itemId: component.itemId,
    quantity: multiplyDecimal(component.quantity, quantity),
  }));
}

/**
 * The cost of building one unit: each component at its cost now, plus the
 * bill's labour and overhead. `costs` maps component to unit cost.
 */
export function rolledUpUnitCost(
  components: readonly BomComponent[],
  costs: ReadonlyMap<string, string>,
  labour: string,
  overhead: string,
): string {
  let total = toUnits(labour) + toUnits(overhead);
  for (const component of components) {
    total += toUnits(multiplyDecimal(component.quantity, costs.get(component.itemId) ?? '0'));
  }
  return fromUnits(total);
}

/**
 * Taking `quantity` units apart: the value they leave stock at (`unitCost`
 * each) is shared among the components in proportion to their own current
 * cost, so the stock's value is unchanged. Returns each component's unit
 * cost; any rounding left over is carried by the first component with
 * stock coming out, so nothing is lost or made.
 */
export function disassemblyUnitCosts(
  needs: readonly { itemId: string; quantity: string }[],
  costs: ReadonlyMap<string, string>,
  quantity: string,
  unitCost: string,
): Map<string, string> {
  const value = toUnits(multiplyDecimal(quantity, unitCost));
  const weights = needs.map((need) =>
    toUnits(multiplyDecimal(need.quantity, costs.get(need.itemId) ?? '0')),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const result = new Map<string, string>();
  let allocated = 0n;
  needs.forEach((need, index) => {
    const quantityUnits = toUnits(need.quantity);
    if (quantityUnits <= 0n) {
      result.set(need.itemId, '0');
      return;
    }
    // Without any cost to go by, the value is shared by quantity.
    const share =
      totalWeight === 0n
        ? (value * quantityUnits) / needs.reduce((sum, other) => sum + toUnits(other.quantity), 0n)
        : (value * (weights[index] ?? 0n)) / totalWeight;
    // Per unit, to four places.
    const perUnit = (share * SCALE) / quantityUnits;
    result.set(need.itemId, fromUnits(perUnit));
    allocated += toUnits(multiplyDecimal(need.quantity, fromUnits(perUnit)));
  });
  const residue = value - allocated;
  const first = needs.find((need) => toUnits(need.quantity) > 0n);
  if (residue !== 0n && first !== undefined) {
    const firstUnits = toUnits(first.quantity);
    const current = toUnits(result.get(first.itemId) ?? '0');
    // Spread over its units; what cannot be spread exactly stays as rounding.
    result.set(first.itemId, fromUnits(current + (residue * SCALE) / firstUnits));
  }
  return result;
}

/**
 * Whether making `itemId` from `componentIds` would make an item part of
 * itself. `billOf` gives each item's active components, if it has a bill.
 */
export function wouldContainItself(
  itemId: string,
  componentIds: readonly string[],
  billOf: (item: string) => readonly string[] | undefined,
): boolean {
  const seen = new Set<string>();
  const stack = [...componentIds];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === itemId) {
      return true;
    }
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    stack.push(...(billOf(next) ?? []));
  }
  return false;
}
