import { ApiRequestError } from '@integr8/api-client';
import { saveAccess } from '@integr8/offline';
import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import { session } from '~/lib/session';
import { localData } from './local-data';

/**
 * The phone's online-only work (ADR-0012): refilling the van, receiving goods
 * at the store, payslips, and the office's view of a job's purchases. None of
 * it goes through the outbox — by the product owner's decision for refills and
 * receipts, and because a payslip is the server's to show — so each screen
 * says plainly when it needs a connection rather than queueing anything.
 *
 * Screens never call the API themselves (see `eslint.config.js`); they call
 * these.
 */

/** Whether the phone has a connection, as far as it can tell. */
export async function isOnline(): Promise<boolean> {
  try {
    const network = await Network.getNetworkStateAsync();
    return network.isConnected !== false && network.isInternetReachable !== false;
  } catch {
    return true;
  }
}

/** Raised by a call made with no connection, so a screen shows "needs a connection". */
export class OfflineError extends Error {
  constructor() {
    super('No connection.');
    this.name = 'OfflineError';
  }
}

/** A failed request with no answer: the connection dropped, or there was none. */
export function isOffline(error: unknown): boolean {
  return error instanceof OfflineError || error instanceof TypeError;
}

async function online(): Promise<void> {
  if (!(await isOnline())) {
    throw new OfflineError();
  }
}

const client = () => session().client;
const idempotencyKey = () => ({ 'Idempotency-Key': Crypto.randomUUID() });

// ---------------------------------------------------------------------------
// What the person may do
// ---------------------------------------------------------------------------

let accessRefreshed = false;

/**
 * Asks once a launch what the person may do, and keeps it on the phone, so a
 * screen for the store or for payslips is offered — offline too — to those it
 * is for. The first download keeps it as well; this keeps it current.
 */
export async function refreshAccess(): Promise<void> {
  if (accessRefreshed) {
    return;
  }
  const status = localData.status();
  if (status.phase !== 'open') {
    return;
  }
  const { data } = await client().GET('/v1/me');
  if (data !== undefined) {
    await status.db.write(['meta'], (sql) => saveAccess(sql, data));
    accessRefreshed = true;
  }
}

// ---------------------------------------------------------------------------
// Refilling the van
// ---------------------------------------------------------------------------

export async function fetchVanProposal() {
  await online();
  const { data } = await client().GET('/v1/inventory/van-requests/proposal', {
    params: { query: {} },
  });
  return data!;
}

export type VanRequest = Awaited<ReturnType<typeof fetchVanRequests>>[number];

/** The engineer's own van's requests: open ones oldest first, then the rest. */
export async function fetchVanRequests() {
  await online();
  const { data } = await client().GET('/v1/inventory/van-requests', {
    params: { query: { limit: 30 } },
  });
  return data?.items ?? [];
}

export async function createVanRequest(input: {
  notes: string;
  lines: { itemId: string; quantity: string }[];
}) {
  await online();
  const { data } = await client().POST('/v1/inventory/van-requests', {
    params: { header: idempotencyKey() },
    body: {
      ...(input.notes.trim() === '' ? {} : { notes: input.notes.trim() }),
      lines: input.lines,
    },
  });
  return data!;
}

export async function cancelVanRequest(requestId: string, expectedVersion: number) {
  await online();
  const { data } = await client().POST('/v1/inventory/van-requests/{requestId}/cancel', {
    params: { path: { requestId } },
    body: { expectedVersion },
  });
  return data!;
}

export type CatalogueItem = Awaited<ReturnType<typeof searchCatalogue>>[number];

/** Stock items in the catalogue matching `text`: what a van can be refilled with. */
export async function searchCatalogue(text: string) {
  await online();
  const { data } = await client().GET('/v1/inventory/items', {
    params: { query: { q: text, kind: ['stock_item'], limit: 20 } },
  });
  return data?.items ?? [];
}

// ---------------------------------------------------------------------------
// A job's purchases, as the office has them
// ---------------------------------------------------------------------------

export type ServerPurchase = Awaited<ReturnType<typeof fetchJobPurchases>>['items'][number];

export async function fetchJobPurchases(workOrderId: string) {
  await online();
  const { data } = await client().GET('/v1/work-orders/{workOrderId}/purchases', {
    params: { path: { workOrderId } },
  });
  return data ?? { items: [], total: null };
}

// ---------------------------------------------------------------------------
// Payslips
// ---------------------------------------------------------------------------

export type Payslip = Awaited<ReturnType<typeof fetchMyPayslips>>[number];

export async function fetchMyPayslips() {
  await online();
  const { data } = await client().GET('/v1/hr/me/payslips', { params: { query: { limit: 24 } } });
  return data?.items ?? [];
}

// ---------------------------------------------------------------------------
// Receiving goods at the store
// ---------------------------------------------------------------------------

export type ReceivableOrder = Awaited<ReturnType<typeof fetchReceivableOrders>>[number];

/** Approved and partly received orders: those goods can still arrive against. */
export async function fetchReceivableOrders() {
  await online();
  const { data } = await client().GET('/v1/purchasing/orders', {
    params: { query: { status: ['approved', 'partially_received'], limit: 50 } },
  });
  return data?.items ?? [];
}

export type PurchaseOrder = Awaited<ReturnType<typeof fetchPurchaseOrder>>;

export async function fetchPurchaseOrder(orderId: string) {
  await online();
  const { data } = await client().GET('/v1/purchasing/orders/{orderId}', {
    params: { path: { orderId } },
  });
  return data!;
}

/** The item with this barcode; undefined when no item has it. */
export async function lookupBarcode(barcode: string) {
  await online();
  try {
    const { data } = await client().GET('/v1/inventory/lookup', {
      params: { query: { barcode } },
    });
    return data;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/** Our warehouses, for an order with no delivery location. */
export async function fetchWarehouses() {
  await online();
  const { data } = await client().GET('/v1/inventory/locations', {
    params: { query: { kind: ['warehouse'] } },
  });
  return (data?.items ?? []).filter(
    (location) => location.archivedAt === null && location.ownership === 'ours',
  );
}

export async function receiveGoods(input: {
  orderId: string;
  expectedVersion: number;
  locationId: string | null;
  supplierNote: string;
  lines: { orderLineId: string; quantity: string }[];
}) {
  await online();
  const { data } = await client().POST('/v1/purchasing/orders/{orderId}/receipts', {
    params: { path: { orderId: input.orderId }, header: idempotencyKey() },
    body: {
      expectedVersion: input.expectedVersion,
      ...(input.locationId === null ? {} : { locationId: input.locationId }),
      ...(input.supplierNote.trim() === '' ? {} : { supplierNote: input.supplierNote.trim() }),
      lines: input.lines,
    },
  });
  return data!;
}
