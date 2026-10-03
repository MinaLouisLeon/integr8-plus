import type { JobListItem } from './queries.js';
import type { SqlConnection } from './sql.js';

/**
 * Finding a job or a customer on the phone, with no signal.
 *
 * Each word the person types is matched as the start of a word, so "riv hou"
 * finds "Riverside Housing" and "123" finds WO-000123. Words are quoted before
 * they reach FTS5, whose query language would otherwise read `-`, `"`, `*`,
 * `AND` or a column name as syntax and fail — or match something unexpected.
 */

export function matchExpression(text: string): string | undefined {
  const words = text
    .split(/[\s\p{P}]+/u)
    .map((word) => word.trim())
    .filter((word) => word !== '');
  if (words.length === 0) {
    return undefined;
  }
  return words.map((word) => `"${word.replaceAll('"', '""')}"*`).join(' ');
}

export interface SearchResults {
  workOrders: JobListItem[];
  customers: { id: string; name: string; accountNumber: string | null; addressText: string }[];
}

export async function searchLocal(
  sql: SqlConnection,
  text: string,
  limit = 25,
): Promise<SearchResults> {
  const expression = matchExpression(text);
  if (expression === undefined) {
    return { workOrders: [], customers: [] };
  }

  const workOrders = await sql.all<{
    id: string;
    reference_label: string;
    title: string;
    state: JobListItem['state'];
    priority: JobListItem['priority'];
    customer_name: string;
    site_name: string;
    site_address: string;
    due_from: string | null;
    due_by: string | null;
    closed_at: string | null;
    hazards: string | null;
  }>(
    `select work_orders.id, work_orders.reference_label, work_orders.title, work_orders.state,
            work_orders.priority, work_orders.customer_name, work_orders.site_name, work_orders.site_address,
            work_orders.due_from, work_orders.due_by, work_orders.closed_at, sites.hazards
     from search
     join work_orders on work_orders.id = search.entity_id
     left join sites on sites.id = work_orders.site_id
     where search match ? and search.kind = 'work_order'
     order by search.rank
     limit ?`,
    [expression, limit],
  );

  const customers = await sql.all<{
    id: string;
    name: string;
    account_number: string | null;
    address_text: string;
  }>(
    `select customers.id, customers.name, customers.account_number, customers.address_text
     from search
     join customers on customers.id = search.entity_id
     where search match ? and search.kind = 'customer'
     order by search.rank
     limit ?`,
    [expression, limit],
  );

  return {
    workOrders: workOrders.map((row) => ({
      id: row.id,
      referenceLabel: row.reference_label,
      title: row.title,
      state: row.state,
      priority: row.priority,
      customerName: row.customer_name,
      siteName: row.site_name,
      siteAddress: row.site_address,
      dueFrom: row.due_from,
      dueBy: row.due_by,
      closedAt: row.closed_at,
      hazards: row.hazards !== null && row.hazards.trim() !== '',
    })),
    customers: customers.map((row) => ({
      id: row.id,
      name: row.name,
      accountNumber: row.account_number,
      addressText: row.address_text,
    })),
  };
}
