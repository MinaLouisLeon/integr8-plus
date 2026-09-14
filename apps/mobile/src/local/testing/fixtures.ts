import { createClient, type Integr8Client } from '@integr8/api-client';
import type {
  CustomerDetail,
  FormDetail,
  Me,
  SiteBody,
  WorkOrderDetail,
  WorkOrderSummary,
} from '../api-types';
import type { SqlConnection } from '../sql';

/**
 * The server's answers, built to the generated contract, and a fake API that
 * serves them — so the download is tested against the shapes the real API sends.
 */

export const TENANT = '0b6a9a4e-0000-4000-8000-000000000001';
export const ENGINEER = '0b6a9a4e-0000-4000-8000-0000000000e1';

let counter = 0;
export function uuid(): string {
  counter += 1;
  return `0b6a9a4e-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function me(overrides: Partial<Me> = {}): Me {
  return {
    userId: ENGINEER,
    tenantId: TENANT,
    email: 'ed@northwind.example',
    displayName: 'Ed Engineer',
    role: 'engineer',
    permissions: [],
    ...overrides,
  };
}

const address = {
  line1: '1 River Road',
  line2: null,
  city: 'Leeds',
  region: null,
  postcode: 'LS1 1AA',
  countryCode: 'GB',
};

const access = {
  gateCode: '4471#',
  parking: 'Visitor bays at the rear',
  askFor: 'Pat, the caretaker',
  hazards: 'Asbestos in the plant room',
  notes: null,
  updatedAt: null,
  updatedBy: null,
};

export function siteBody(customerId: string, overrides: Partial<SiteBody> = {}): SiteBody {
  return {
    id: uuid(),
    customerId,
    name: 'Block A',
    address,
    location: { latitude: 53.8, longitude: -1.55 },
    geocodeStatus: 'found',
    geocodeAccuracy: 'address',
    contactId: null,
    access,
    archived: false,
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

export function customerDetail(
  overrides: { name?: string; accountNumber?: string | null; sites?: SiteBody[] } = {},
): CustomerDetail {
  const id = uuid();
  const contactId = uuid();
  return {
    customer: {
      id,
      name: overrides.name ?? 'Riverside Housing',
      accountNumber: overrides.accountNumber ?? 'RH-001',
      status: 'active',
      email: 'office@riverside.example',
      phone: '0113 496 0000',
      address,
      tags: [],
      notes: null,
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:00:00.000Z',
    },
    contacts: [
      {
        id: contactId,
        name: 'Pat Caretaker',
        jobTitle: 'Caretaker',
        email: null,
        phone: '07700 900123',
        isPrimary: true,
        notes: null,
        archived: false,
      },
    ],
    sites: overrides.sites ?? [siteBody(id, { contactId })],
    attachments: [],
    recentWorkOrders: [],
    can: { edit: false, createWorkOrder: false },
  };
}

export function workOrderDetail(
  customer: CustomerDetail,
  overrides: {
    state?: WorkOrderDetail['workOrder']['state'];
    title?: string;
    dueBy?: string | null;
    completedAt?: string | null;
    cancelledAt?: string | null;
    formIds?: string[];
    site?: SiteBody;
  } = {},
): WorkOrderDetail {
  counter += 1;
  const reference = counter;
  const site = overrides.site ?? customer.sites[0]!;
  const state = overrides.state ?? 'dispatched';
  return {
    workOrder: {
      id: uuid(),
      reference,
      referenceLabel: `WO-${String(reference).padStart(6, '0')}`,
      title: overrides.title ?? 'Boiler service',
      state,
      priority: 'normal',
      dueFrom: null,
      dueBy: overrides.dueBy === undefined ? '2026-09-20T17:00:00.000Z' : overrides.dueBy,
      customer: { id: customer.customer.id, name: customer.customer.name },
      site: { id: site.id, name: site.name, city: site.address.city },
      jobType: { id: uuid(), name: 'Boiler service', code: 'BOILER-SERVICE' },
      crew: [{ id: ENGINEER, name: 'Ed Engineer', lead: true }],
      revision: 1,
      stateChangedAt: '2026-09-10T09:00:00.000Z',
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-10T09:00:00.000Z',
      description: 'Annual service, flat 4',
      instructions: 'Record the working pressure.',
      lastReason: null,
      completedAt: overrides.completedAt ?? null,
      reviewedAt: null,
      cancelledAt: overrides.cancelledAt ?? null,
    },
    site: {
      id: site.id,
      name: site.name,
      address: site.address,
      location: site.location,
      geocodeStatus: site.geocodeStatus,
      access: site.access,
    },
    siteContact: customer.contacts[0] ?? null,
    customer: {
      id: customer.customer.id,
      name: customer.customer.name,
      accountNumber: customer.customer.accountNumber,
      status: customer.customer.status,
      phone: customer.customer.phone,
    },
    jobType: {
      id: uuid(),
      name: 'Boiler service',
      code: 'BOILER-SERVICE',
      expectedDurationMinutes: 90,
    },
    crew: [
      { id: ENGINEER, name: 'Ed Engineer', lead: true, assignedAt: '2026-09-01T09:00:00.000Z' },
    ],
    forms: (overrides.formIds ?? []).map((formId) => ({
      formId,
      title: 'Gas safety check',
      required: true,
      submission: null,
    })),
    checklist: [],
    comments: [],
    events: [],
    attachments: [],
    previousAtSite: [],
    can: { edit: false, assign: false, work: true, comment: true, transitions: [] },
  };
}

export function formDetail(overrides: { live?: boolean } = {}): FormDetail {
  const id = uuid();
  return {
    form: {
      id,
      title: 'Gas safety check',
      fillRoles: ['engineer'],
      signatureRequired: false,
      requiredByJobTypeIds: [],
      clonedFromFormId: null,
      sourceTemplateKey: null,
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:00:00.000Z',
    },
    draft: null,
    live:
      overrides.live === false
        ? null
        : {
            id: uuid(),
            formId: id,
            status: 'published',
            versionNumber: 1,
            revision: 1,
            changeNote: null,
            changes: null,
            createdAt: '2026-09-01T09:00:00.000Z',
            updatedAt: '2026-09-01T09:00:00.000Z',
            publishedAt: '2026-09-01T09:00:00.000Z',
            publishedBy: null,
            definition: {
              schemaVersion: 1,
              title: { en: 'Gas safety check' },
              pages: [],
            } as unknown as NonNullable<FormDetail['live']>['definition'],
          },
  };
}

export function summaryOf(detail: WorkOrderDetail): WorkOrderSummary {
  const { workOrder } = detail;
  return {
    id: workOrder.id,
    reference: workOrder.reference,
    referenceLabel: workOrder.referenceLabel,
    title: workOrder.title,
    state: workOrder.state,
    priority: workOrder.priority,
    dueFrom: workOrder.dueFrom,
    dueBy: workOrder.dueBy,
    customer: workOrder.customer,
    site: workOrder.site,
    jobType: workOrder.jobType,
    crew: workOrder.crew,
    revision: workOrder.revision,
    stateChangedAt: workOrder.stateChangedAt,
    createdAt: workOrder.createdAt,
    updatedAt: workOrder.updatedAt,
  };
}

export interface FakeServer {
  me: Me;
  /** Jobs the engineer is on, by id. */
  workOrders: Map<string, WorkOrderDetail>;
  customers: Map<string, CustomerDetail>;
  forms: Map<string, FormDetail>;
  /** Every request's path and query, in order. */
  requests: URL[];
  /** Answers this status for any path that starts with the key. */
  failures: Map<string, number>;
  pageSize: number;
}

export function fakeServer(): FakeServer {
  return {
    me: me(),
    workOrders: new Map(),
    customers: new Map(),
    forms: new Map(),
    requests: [],
    failures: new Map(),
    pageSize: 200,
  };
}

const CLOSED = new Set(['complete', 'reviewed', 'cancelled']);

export function clientFor(server: FakeServer): Integr8Client {
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const handle = (url: URL): Response => {
    for (const [prefix, status] of server.failures) {
      if (url.pathname.startsWith(prefix)) {
        return respond(status, { error: { code: 'failed', message: 'Failed', requestId: 'r' } });
      }
    }
    const notFound = () =>
      respond(404, { error: { code: 'not_found', message: 'Not found', requestId: 'r' } });
    const path = url.pathname;
    if (path === '/v1/me') {
      return respond(200, server.me);
    }
    if (path === '/v1/work-orders') {
      const states = url.searchParams.getAll('state');
      const closedSince = url.searchParams.get('closedSince');
      const matching = [...server.workOrders.values()].filter((detail) => {
        const { workOrder } = detail;
        if (states.length > 0 && !states.includes(workOrder.state)) {
          return false;
        }
        if (closedSince !== null) {
          const closed = workOrder.completedAt ?? workOrder.cancelledAt;
          return CLOSED.has(workOrder.state) && closed !== null && closed >= closedSince;
        }
        return true;
      });
      const start = Number(url.searchParams.get('cursor') ?? '0');
      const page = matching.slice(start, start + server.pageSize);
      const next =
        start + server.pageSize < matching.length ? String(start + server.pageSize) : null;
      return respond(200, { items: page.map(summaryOf), nextCursor: next, counts: {} });
    }
    const [, , kind, id] = path.split('/');
    if (kind === 'work-orders' && id !== undefined) {
      const detail = server.workOrders.get(id);
      return detail === undefined ? notFound() : respond(200, detail);
    }
    if (kind === 'customers' && id !== undefined) {
      const detail = server.customers.get(id);
      return detail === undefined ? notFound() : respond(200, detail);
    }
    if (kind === 'forms' && id !== undefined) {
      const detail = server.forms.get(id);
      return detail === undefined ? notFound() : respond(200, detail);
    }
    return notFound();
  };

  return createClient({
    baseUrl: 'https://api.integr8.example',
    clientApp: 'mobile',
    clientVersion: '0.1.0',
    getAccessToken: () => 'token',
    fetch: (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      server.requests.push(url);
      return Promise.resolve(handle(url));
    },
  });
}

/** Puts a job and what it needs on the fake server. */
export function serve(
  server: FakeServer,
  ...entries: { customer: CustomerDetail; workOrder: WorkOrderDetail; forms?: FormDetail[] }[]
): void {
  for (const entry of entries) {
    server.customers.set(entry.customer.customer.id, entry.customer);
    server.workOrders.set(entry.workOrder.workOrder.id, entry.workOrder);
    for (const form of entry.forms ?? []) {
      server.forms.set(form.form.id, form);
    }
  }
}

/** Unsent work, written the way P13 will write it. */
export async function insertDraft(
  sql: SqlConnection,
  draft: { id?: string; formId: string; formVersionId: string; workOrderId: string | null },
): Promise<string> {
  const id = draft.id ?? uuid();
  await sql.run(
    `insert into drafts (id, form_id, form_version_id, work_order_id, answers, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      draft.formId,
      draft.formVersionId,
      draft.workOrderId,
      JSON.stringify({ note: 'Flue terminal cracked; isolated.' }),
      '2026-08-01T09:00:00.000Z',
      '2026-08-01T09:30:00.000Z',
    ],
  );
  return id;
}

export async function insertFile(
  sql: SqlConnection,
  file: {
    id?: string;
    ownerKind: 'work_order' | 'customer' | 'site' | 'draft';
    ownerId: string;
    state: 'downloaded' | 'pending_upload';
    byteSize: number;
    lastOpenedAt?: string;
  },
): Promise<string> {
  const id = file.id ?? uuid();
  await sql.run(
    `insert into files (id, owner_kind, owner_id, name, content_type, byte_size, local_path, state, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      file.ownerKind,
      file.ownerId,
      `${id}.jpg`,
      'image/jpeg',
      file.byteSize,
      `files/${id}.jpg`,
      file.state,
      '2026-08-01T09:00:00.000Z',
      file.lastOpenedAt ?? '2026-08-01T09:00:00.000Z',
    ],
  );
  return id;
}
