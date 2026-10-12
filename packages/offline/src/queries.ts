import type { CustomerDetail, SiteBody, WorkOrderDetail } from './api-types.js';
import type { SqlConnection } from './sql.js';
import { UNSENT_WORK_COUNT } from './unsent.js';

/**
 * Everything a screen reads. Nothing here touches the network.
 */

export interface JobListItem {
  id: string;
  referenceLabel: string;
  title: string;
  state: WorkOrderDetail['workOrder']['state'];
  priority: WorkOrderDetail['workOrder']['priority'];
  customerName: string;
  siteName: string;
  siteAddress: string;
  dueFrom: string | null;
  dueBy: string | null;
  closedAt: string | null;
  /** Whether the site has hazards on arrival, so the list can warn before the job is opened. */
  hazards: boolean;
}

interface JobRow {
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
}

const JOB_COLUMNS = `work_orders.id, work_orders.reference_label, work_orders.title, work_orders.state,
  work_orders.priority, work_orders.customer_name, work_orders.site_name, work_orders.site_address,
  work_orders.due_from, work_orders.due_by, work_orders.closed_at, sites.hazards`;

const JOBS_FROM = `work_orders left join sites on sites.id = work_orders.site_id`;

function toJob(row: JobRow): JobListItem {
  return {
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
  };
}

/** Open jobs, soonest due first; undated jobs last. */
export async function openJobs(sql: SqlConnection): Promise<JobListItem[]> {
  const rows = await sql.all<JobRow>(
    `select ${JOB_COLUMNS} from ${JOBS_FROM}
     where work_orders.closed_at is null
     order by work_orders.due_by is null, work_orders.due_by, work_orders.reference`,
  );
  return rows.map(toJob);
}

export async function recentlyClosedJobs(sql: SqlConnection, limit = 50): Promise<JobListItem[]> {
  const rows = await sql.all<JobRow>(
    `select ${JOB_COLUMNS} from ${JOBS_FROM}
     where work_orders.closed_at is not null
     order by work_orders.closed_at desc
     limit ?`,
    [limit],
  );
  return rows.map(toJob);
}

export interface JobSections {
  overdue: JobListItem[];
  today: JobListItem[];
  upcoming: JobListItem[];
  unscheduled: JobListItem[];
}

/** Splits open jobs by the phone's own calendar day. */
export function sectionJobs(jobs: readonly JobListItem[], now: Date): JobSections {
  const endOfToday = new Date(now);
  endOfToday.setHours(24, 0, 0, 0);
  const sections: JobSections = { overdue: [], today: [], upcoming: [], unscheduled: [] };
  for (const job of jobs) {
    if (job.dueBy === null && job.dueFrom === null) {
      sections.unscheduled.push(job);
    } else if (job.dueBy !== null && new Date(job.dueBy) < now) {
      sections.overdue.push(job);
    } else if (new Date(job.dueFrom ?? job.dueBy!) < endOfToday) {
      sections.today.push(job);
    } else {
      sections.upcoming.push(job);
    }
  }
  return sections;
}

export interface LocalJob {
  detail: WorkOrderDetail;
  downloadedAt: string;
}

export async function job(sql: SqlConnection, id: string): Promise<LocalJob | undefined> {
  const row = await sql.get<{ data: string; downloaded_at: string }>(
    'select data, downloaded_at from work_orders where id = ?',
    [id],
  );
  return row === undefined
    ? undefined
    : { detail: JSON.parse(row.data) as WorkOrderDetail, downloadedAt: row.downloaded_at };
}

export interface LocalCustomer {
  customer: CustomerDetail['customer'];
  contacts: CustomerDetail['contacts'];
  sites: { id: string; name: string; addressText: string; hazards: boolean }[];
  jobs: JobListItem[];
}

export async function customer(sql: SqlConnection, id: string): Promise<LocalCustomer | undefined> {
  const row = await sql.get<{ data: string }>('select data from customers where id = ?', [id]);
  if (row === undefined) {
    return undefined;
  }
  const data = JSON.parse(row.data) as Pick<CustomerDetail, 'customer' | 'contacts'>;
  const sites = await sql.all<{
    id: string;
    name: string;
    address_text: string;
    hazards: string | null;
  }>('select id, name, address_text, hazards from sites where customer_id = ? order by name', [id]);
  const jobs = await sql.all<JobRow>(
    `select ${JOB_COLUMNS} from ${JOBS_FROM}
     where work_orders.customer_id = ?
     order by work_orders.closed_at is not null, coalesce(work_orders.closed_at, work_orders.due_by) desc`,
    [id],
  );
  return {
    customer: data.customer,
    contacts: data.contacts,
    sites: sites.map((site) => ({
      id: site.id,
      name: site.name,
      addressText: site.address_text,
      hazards: site.hazards !== null && site.hazards.trim() !== '',
    })),
    jobs: jobs.map(toJob),
  };
}

export interface LocalSite {
  site: SiteBody;
  customer: { id: string; name: string };
  contact: CustomerDetail['contacts'][number] | null;
  jobs: JobListItem[];
}

export async function site(sql: SqlConnection, id: string): Promise<LocalSite | undefined> {
  const row = await sql.get<{ data: string; customer_id: string; customer_data: string | null }>(
    `select sites.data, sites.customer_id, customers.data as customer_data
     from sites left join customers on customers.id = sites.customer_id
     where sites.id = ?`,
    [id],
  );
  if (row === undefined) {
    return undefined;
  }
  const body = JSON.parse(row.data) as SiteBody;
  const owner =
    row.customer_data === null
      ? undefined
      : (JSON.parse(row.customer_data) as Pick<CustomerDetail, 'customer' | 'contacts'>);
  const jobs = await sql.all<JobRow>(
    `select ${JOB_COLUMNS} from ${JOBS_FROM}
     where work_orders.site_id = ?
     order by work_orders.closed_at is not null, coalesce(work_orders.closed_at, work_orders.due_by) desc`,
    [id],
  );
  return {
    site: body,
    customer: { id: row.customer_id, name: owner?.customer.name ?? '' },
    contact: owner?.contacts.find((contact) => contact.id === body.contactId) ?? null,
    jobs: jobs.map(toJob),
  };
}

export interface Identity {
  tenantId: string;
  userId: string;
  displayName: string;
  email: string;
  role: string;
  /** The company's name, logo and colours, as the app should wear them. */
  company: {
    name: string;
    /** Empty until a download made after the slug joined the snapshot. */
    slug: string;
    brandColour: string | null;
    shellColour: string | null;
    defaultTheme: 'light' | 'dark' | 'system';
    websiteUrl: string | null;
    logoMediaId: string | null;
    appIconMediaId: string | null;
  };
  lastDownloadAt: string | null;
}

/** The meta table stores strings; an empty one is the absence of a value. */
function orNull(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** A theme the app knows; anything else — or a download older than the setting — follows the phone. */
function themeOf(value: string | undefined): Identity['company']['defaultTheme'] {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export async function identity(sql: SqlConnection): Promise<Identity | undefined> {
  const rows = await sql.all<{ key: string; value: string }>('select key, value from meta');
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  const tenantId = meta.get('tenant_id');
  const userId = meta.get('user_id');
  if (tenantId === undefined || userId === undefined) {
    return undefined;
  }
  return {
    tenantId,
    userId,
    displayName: meta.get('display_name') ?? '',
    email: meta.get('email') ?? '',
    role: meta.get('role') ?? '',
    company: {
      name: meta.get('company_name') ?? '',
      slug: meta.get('company_slug') ?? '',
      brandColour: orNull(meta.get('brand_colour')),
      shellColour: orNull(meta.get('shell_colour')),
      defaultTheme: themeOf(meta.get('default_theme')),
      websiteUrl: orNull(meta.get('website_url')),
      logoMediaId: orNull(meta.get('logo_media_id')),
      appIconMediaId: orNull(meta.get('app_icon_media_id')),
    },
    lastDownloadAt: meta.get('last_download_at') ?? null,
  };
}

export interface StorageSummary {
  openJobs: number;
  closedJobs: number;
  customers: number;
  forms: number;
  /** Changes, files and forms the server has not received. */
  unsentWork: number;
  pendingUploads: number;
  downloadedFileBytes: number;
}

export async function storageSummary(sql: SqlConnection): Promise<StorageSummary> {
  const row = await sql.get<{
    open_jobs: number;
    closed_jobs: number;
    customers: number;
    forms: number;
    unsent_work: number;
    pending_uploads: number;
    downloaded_file_bytes: number;
  }>(
    `select
       (select count(*) from work_orders where closed_at is null) as open_jobs,
       (select count(*) from work_orders where closed_at is not null) as closed_jobs,
       (select count(*) from customers) as customers,
       (select count(*) from forms) as forms,
       ${UNSENT_WORK_COUNT} as unsent_work,
       (select count(*) from uploads where state <> 'confirmed') as pending_uploads,
       (select coalesce(sum(byte_size), 0) from files where state = 'downloaded') as downloaded_file_bytes`,
  );
  return {
    openJobs: row?.open_jobs ?? 0,
    closedJobs: row?.closed_jobs ?? 0,
    customers: row?.customers ?? 0,
    forms: row?.forms ?? 0,
    unsentWork: row?.unsent_work ?? 0,
    pendingUploads: row?.pending_uploads ?? 0,
    downloadedFileBytes: row?.downloaded_file_bytes ?? 0,
  };
}

/** Work on the phone that has not reached the server: signing out would delete it. */
export async function unsentWorkCount(sql: SqlConnection): Promise<number> {
  return (await storageSummary(sql)).unsentWork;
}

// ---------------------------------------------------------------------------
// The van (CRM/ERP plan, phase E2)
// ---------------------------------------------------------------------------

/** A serial number or batch in the van, as the server last said (ADR-0013). */
export interface VanLot {
  lotId: string;
  kind: 'serial' | 'batch';
  code: string;
  /** `YYYY-MM-DD`, for a batch that expires. */
  expiresOn: string | null;
  onHand: string;
  /** `onHand` less this phone's own unsent uses of it. */
  forecast: string;
}

export interface VanStockRow {
  item: {
    id: string;
    sku: string;
    name: string;
    kind: string;
    unit: string;
    tracking: 'none' | 'serial' | 'batch';
  };
  /** The van's serial numbers or batches of the item, earliest expiry first. */
  lots: VanLot[];
  location: { id: string; name: string };
  /** What the server last said the van held. */
  onHand: string;
  /** `onHand` less this phone's own uses not yet applied: what is probably left. */
  forecast: string;
  /** Promised to sales orders from the van, as the server last said (ADR-0012). */
  reserved: string;
  /** On hand less reserved, never below zero, as the server last said. */
  available: string;
  /** `available` less this phone's own uses not yet applied. */
  availableForecast: string;
  /** The item's main image, and where the phone keeps it once downloaded. */
  mainImageFileId: string | null;
  /** Relative to the files directory; null until it has downloaded. */
  imagePath: string | null;
  updatedAt: string;
}

/** Subtracts decimal strings of up to four places exactly, never below zero. */
function minus(held: string, used: readonly string[]): string {
  const scale = (text: string) => {
    const [whole = '0', fraction = ''] = text.split('.');
    return BigInt(whole + fraction.padEnd(4, '0').slice(0, 4));
  };
  let left = scale(held);
  for (const quantity of used) {
    left -= scale(quantity);
  }
  if (left <= 0n) {
    return '0';
  }
  const digits = left.toString().padStart(5, '0');
  return `${digits.slice(0, -4)}.${digits.slice(-4)}`.replace(/\.?0+$/u, '');
}

/**
 * What the engineer's van holds, with this phone's own unsent uses taken off.
 * A forecast, and shown as one: the server's count is the count (ADR-0005).
 */
export async function vanStock(sql: SqlConnection): Promise<VanStockRow[]> {
  const rows = await sql.all<{
    item_id: string;
    location_id: string;
    location_name: string;
    sku: string;
    name: string;
    kind: string;
    unit: string;
    on_hand: string;
    reserved: string | null;
    available: string | null;
    main_image_file_id: string | null;
    image_path: string | null;
    tracking: string | null;
    lots: string | null;
    updated_at: string;
  }>(
    `select van_stock.*, item_images.local_path as image_path
     from van_stock left join item_images on item_images.file_id = van_stock.main_image_file_id
     order by name, sku`,
  );
  const pending = await sql.all<{ payload: string }>(
    `select payload from outbox where kind = 'work_order.material' and state <> 'done'`,
  );
  const used = new Map<string, string[]>();
  const usedOfLot = new Map<string, string[]>();
  for (const row of pending) {
    const payload = JSON.parse(row.payload) as {
      itemId: string;
      quantity: string;
      lots?: { lotId: string; quantity: string }[];
    };
    used.set(payload.itemId, [...(used.get(payload.itemId) ?? []), payload.quantity]);
    for (const lot of payload.lots ?? []) {
      usedOfLot.set(lot.lotId, [...(usedOfLot.get(lot.lotId) ?? []), lot.quantity]);
    }
  }
  return rows.map((row) => {
    const own = used.get(row.item_id) ?? [];
    // A row from a server that did not say what is reserved: none is.
    const available = row.available ?? row.on_hand;
    return {
      item: {
        id: row.item_id,
        sku: row.sku,
        name: row.name,
        kind: row.kind,
        unit: row.unit,
        tracking: (row.tracking ?? 'none') as VanStockRow['item']['tracking'],
      },
      lots: (JSON.parse(row.lots ?? '[]') as Omit<VanLot, 'forecast'>[]).map((lot) => ({
        ...lot,
        forecast: minus(lot.onHand, usedOfLot.get(lot.lotId) ?? []),
      })),
      location: { id: row.location_id, name: row.location_name },
      onHand: row.on_hand,
      forecast: minus(row.on_hand, own),
      reserved: row.reserved ?? '0',
      available,
      availableForecast: minus(available, own),
      mainImageFileId: row.main_image_file_id,
      imagePath: row.image_path,
      updatedAt: row.updated_at,
    };
  });
}

/** The engineer's van as the server last said; null without one, undefined before it has said. */
export async function van(
  sql: SqlConnection,
): Promise<{ id: string; name: string } | null | undefined> {
  const row = await sql.get<{ value: string }>(`select value from meta where key = 'van'`);
  return row === undefined
    ? undefined
    : (JSON.parse(row.value) as { id: string; name: string } | null);
}
