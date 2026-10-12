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

// ---------------------------------------------------------------------------
// Planning (MRP)
// ---------------------------------------------------------------------------

export interface PlanItem {
  id: string;
  kind: 'stock_item' | 'non_stock_item' | 'service';
  /** Days to build or to arrive; null to use the supplier's. */
  leadTimeDays: number | null;
  supplierId: string | null;
  supplierLeadTimeDays: number | null;
  /** The bill in use, for an item that is built. */
  bom: { id: string; components: readonly BomComponent[] } | null;
}

/** Where a demand comes from. */
export type DemandSource = 'sales' | 'assembly' | 'parent';

export interface PlanDemand {
  itemId: string;
  quantity: string;
  /** `YYYY-MM-DD`; before today counts as today. */
  date: string;
  source: DemandSource;
}

export interface PlanSupply {
  itemId: string;
  quantity: string;
  date: string;
  source: 'purchase' | 'assembly';
}

export interface PlanInput {
  today: string;
  horizonEnd: string;
  items: ReadonlyMap<string, PlanItem>;
  onHand: ReadonlyMap<string, string>;
  reorderMinimum: ReadonlyMap<string, string>;
  demands: readonly PlanDemand[];
  supplies: readonly PlanSupply[];
}

/** What a suggestion rests on, stored with it and shown beside it. */
export interface PlanBasis {
  sales: string;
  assembly: string;
  parent: string;
  /** Days later than the lead time allows; 0 when there is time. */
  lateByDays: number;
}

export interface PlanSuggestion {
  itemId: string;
  action: 'build' | 'buy';
  level: number;
  required: string;
  available: string;
  onOrder: string;
  reorderMinimum: string;
  quantity: string;
  needBy: string;
  orderBy: string;
  leadTimeDays: number;
  supplierId: string | null;
  bomId: string | null;
  basis: PlanBasis;
}

const DAY = 86_400_000;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * Material requirements, level by level: what is sold is level 0, its parts
 * level 1 and so on, an item taking the deepest level it appears at so all
 * its demand is known before it is planned. For each item, what is needed
 * (demand within the horizon, plus its reorder level) less what is on hand
 * and on order is suggested: built when it has a bill, bought otherwise. A
 * build's parts are needed by the day it must start.
 */
export function planMaterials(input: PlanInput): PlanSuggestion[] {
  const level = new Map<string, number>();
  for (const id of input.items.keys()) {
    level.set(id, 0);
  }
  // Deepest level by relaxation; the depth is bounded by the item count.
  for (let pass = 0; pass <= input.items.size; pass += 1) {
    let changed = false;
    for (const item of input.items.values()) {
      for (const component of item.bom?.components ?? []) {
        const wanted = (level.get(item.id) ?? 0) + 1;
        if ((level.get(component.itemId) ?? 0) < wanted && wanted <= input.items.size) {
          level.set(component.itemId, wanted);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  const inHorizon = (date: string) => date <= input.horizonEnd;
  const demands = new Map<string, PlanDemand[]>();
  for (const demand of input.demands) {
    if (inHorizon(demand.date)) {
      demands.set(demand.itemId, [...(demands.get(demand.itemId) ?? []), demand]);
    }
  }
  const onOrder = new Map<string, bigint>();
  for (const supply of input.supplies) {
    if (inHorizon(supply.date)) {
      onOrder.set(supply.itemId, (onOrder.get(supply.itemId) ?? 0n) + toUnits(supply.quantity));
    }
  }

  const order = [...input.items.values()]
    .filter((item) => item.kind !== 'service')
    .sort((a, b) => (level.get(a.id) ?? 0) - (level.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  const suggestions: PlanSuggestion[] = [];
  for (const item of order) {
    const own = demands.get(item.id) ?? [];
    const by = (source: DemandSource) =>
      own
        .filter((demand) => demand.source === source)
        .reduce((sum, demand) => sum + toUnits(demand.quantity), 0n);
    const required = by('sales') + by('assembly') + by('parent');
    const minimum = toUnits(input.reorderMinimum.get(item.id) ?? '0');
    const held = item.kind === 'stock_item' ? toUnits(input.onHand.get(item.id) ?? '0') : 0n;
    const coming = onOrder.get(item.id) ?? 0n;
    const net = required + minimum - held - coming;
    if (net <= 0n) {
      continue;
    }
    const build = item.kind === 'stock_item' && item.bom !== null;
    const earliest = own.map((demand) => demand.date).sort()[0] ?? input.today;
    const needBy = later(earliest, input.today);
    const leadTimeDays = item.leadTimeDays ?? (build ? 0 : (item.supplierLeadTimeDays ?? 0));
    const ideal = addDays(needBy, -leadTimeDays);
    const orderBy = later(ideal, input.today);
    const quantity = fromUnits(net);
    suggestions.push({
      itemId: item.id,
      action: build ? 'build' : 'buy',
      level: level.get(item.id) ?? 0,
      required: fromUnits(required),
      available: fromUnits(held),
      onOrder: fromUnits(coming),
      reorderMinimum: fromUnits(minimum),
      quantity,
      needBy,
      orderBy,
      leadTimeDays,
      supplierId: build ? null : item.supplierId,
      bomId: build ? (item.bom?.id ?? null) : null,
      basis: {
        sales: fromUnits(by('sales')),
        assembly: fromUnits(by('assembly')),
        parent: fromUnits(by('parent')),
        lateByDays: Math.max(0, daysBetween(ideal, input.today)),
      },
    });
    if (build) {
      for (const need of componentNeeds(item.bom?.components ?? [], quantity)) {
        demands.set(need.itemId, [
          ...(demands.get(need.itemId) ?? []),
          { itemId: need.itemId, quantity: need.quantity, date: orderBy, source: 'parent' },
        ]);
      }
    }
  }
  return suggestions;
}
