import { CLOSED_WORK_ORDER_STATES } from '@integr8/core';
import type { CustomerDetail, FormDetail, Me, SiteBody, WorkOrderDetail } from './api-types.js';
import type { SqlConnection } from './sql.js';
import { UNSENT_WORK_ORDER_IDS } from './unsent.js';

/**
 * Writing what the server said into the phone's tables.
 *
 * A download is a snapshot of the engineer's work: their open jobs, what they
 * closed recently, the customers and sites those jobs are at, and the forms they
 * need. It replaces the downloaded rows and never touches unsent work — a job
 * the server no longer lists stays while a draft or an upload still points at
 * it, so an engineer taken off a job mid-visit does not lose what they wrote.
 */

export interface Snapshot {
  me: Me;
  workOrders: readonly WorkOrderDetail[];
  customers: readonly CustomerDetail[];
  forms: readonly FormDetail[];
}

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
}

export function addressText(address: Address): string {
  return [address.line1, address.line2, address.city, address.region, address.postcode]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
}

/** When a closed job closed: completed, or cancelled if it never was. */
export function closedAt(workOrder: WorkOrderDetail['workOrder']): string | null {
  if (!CLOSED_WORK_ORDER_STATES.includes(workOrder.state)) {
    return null;
  }
  return iso(workOrder.completedAt ?? workOrder.cancelledAt ?? workOrder.stateChangedAt);
}

/** Every timestamp is stored as UTC ISO 8601, so comparing the text compares the instants. */
function iso(value: string): string;
function iso(value: string | null): string | null;
function iso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function applySnapshot(
  sql: SqlConnection,
  snapshot: Snapshot,
  now: Date,
): Promise<{ removedWorkOrders: number }> {
  const at = now.toISOString();

  for (const [key, value] of Object.entries({
    tenant_id: snapshot.me.tenantId,
    user_id: snapshot.me.userId,
    display_name: snapshot.me.displayName,
    email: snapshot.me.email,
    role: snapshot.me.role,
    // The company's own brand, so the phone wears it offline too. An empty
    // value is "none", which `identity` turns back into null.
    company_name: snapshot.me.company.name,
    brand_colour: snapshot.me.company.brandColour ?? '',
    logo_media_id: snapshot.me.company.logoMediaId ?? '',
    last_download_at: at,
  })) {
    await sql.run(
      'insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
      [key, value],
    );
  }

  for (const detail of snapshot.customers) {
    await upsertCustomer(sql, detail, at);
    for (const site of detail.sites) {
      await upsertSite(sql, site, at);
    }
  }

  for (const detail of snapshot.workOrders) {
    await upsertWorkOrder(sql, detail, at);
  }

  for (const form of snapshot.forms) {
    await upsertForm(sql, form, at);
  }

  const kept = JSON.stringify(snapshot.workOrders.map((detail) => detail.workOrder.id));
  const removed = await sql.run(
    `delete from work_orders
     where id not in (select value from json_each(?))
       and id not in (${UNSENT_WORK_ORDER_IDS})`,
    [kept],
  );

  return { removedWorkOrders: removed.changes };
}

export async function upsertCustomer(sql: SqlConnection, detail: CustomerDetail, at: string) {
  const { customer } = detail;
  await sql.run(
    `insert into customers (id, name, account_number, status, phone, email, address_text, data, downloaded_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       name = excluded.name, account_number = excluded.account_number, status = excluded.status,
       phone = excluded.phone, email = excluded.email, address_text = excluded.address_text,
       data = excluded.data, downloaded_at = excluded.downloaded_at`,
    [
      customer.id,
      customer.name,
      customer.accountNumber,
      customer.status,
      customer.phone,
      customer.email,
      addressText(customer.address),
      JSON.stringify({ customer, contacts: detail.contacts, attachments: detail.attachments }),
      at,
    ],
  );
}

export async function upsertSite(sql: SqlConnection, site: SiteBody, at: string) {
  await sql.run(
    `insert into sites (id, customer_id, name, address_text, latitude, longitude,
                        gate_code, parking, ask_for, hazards, access_notes, data, downloaded_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       customer_id = excluded.customer_id, name = excluded.name, address_text = excluded.address_text,
       latitude = excluded.latitude, longitude = excluded.longitude, gate_code = excluded.gate_code,
       parking = excluded.parking, ask_for = excluded.ask_for, hazards = excluded.hazards,
       access_notes = excluded.access_notes, data = excluded.data, downloaded_at = excluded.downloaded_at`,
    [
      site.id,
      site.customerId,
      site.name,
      addressText(site.address),
      site.location?.latitude ?? null,
      site.location?.longitude ?? null,
      site.access.gateCode,
      site.access.parking,
      site.access.askFor,
      site.access.hazards,
      site.access.notes,
      JSON.stringify(site),
      at,
    ],
  );
}

export async function upsertWorkOrder(sql: SqlConnection, detail: WorkOrderDetail, at: string) {
  const { workOrder, site, customer, jobType } = detail;
  await sql.run(
    `insert into work_orders (id, reference, reference_label, title, state, priority,
                              customer_id, customer_name, site_id, site_name, site_address, job_type_name,
                              due_from, due_by, closed_at, data, downloaded_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       reference = excluded.reference, reference_label = excluded.reference_label, title = excluded.title,
       state = excluded.state, priority = excluded.priority, customer_id = excluded.customer_id,
       customer_name = excluded.customer_name, site_id = excluded.site_id, site_name = excluded.site_name,
       site_address = excluded.site_address, job_type_name = excluded.job_type_name,
       due_from = excluded.due_from, due_by = excluded.due_by, closed_at = excluded.closed_at,
       data = excluded.data, downloaded_at = excluded.downloaded_at`,
    [
      workOrder.id,
      workOrder.reference,
      workOrder.referenceLabel,
      workOrder.title,
      workOrder.state,
      workOrder.priority,
      customer.id,
      customer.name,
      site.id,
      site.name,
      addressText(site.address),
      jobType.name,
      iso(workOrder.dueFrom),
      iso(workOrder.dueBy),
      closedAt(workOrder),
      JSON.stringify(detail),
      at,
    ],
  );
}

export async function upsertForm(sql: SqlConnection, detail: FormDetail, at: string) {
  const { form, live } = detail;
  await sql.run(
    `insert into forms (id, title, live_version_id, downloaded_at) values (?, ?, ?, ?)
     on conflict (id) do update set
       title = excluded.title, live_version_id = excluded.live_version_id, downloaded_at = excluded.downloaded_at`,
    [form.id, form.title, live?.id ?? null, at],
  );
  if (live !== null) {
    // A published version never changes, so one already here is left as it is.
    await sql.run(
      `insert into form_versions (id, form_id, version_number, definition, downloaded_at)
       values (?, ?, ?, ?, ?) on conflict (id) do nothing`,
      [live.id, form.id, live.versionNumber, JSON.stringify(live.definition), at],
    );
  }
}
