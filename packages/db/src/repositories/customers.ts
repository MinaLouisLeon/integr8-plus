import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CustomerContactsTable, CustomerStatus, CustomersTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postcode: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
}

export interface Customer {
  id: string;
  tenantId: TenantId;
  name: string;
  accountNumber: string | null;
  status: CustomerStatus;
  email: string | null;
  phone: string | null;
  address: Address;
  tags: string[];
  notes: string | null;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerInput {
  name: string;
  accountNumber?: string | null;
  status?: CustomerStatus;
  email?: string | null;
  phone?: string | null;
  address?: Partial<Address>;
  tags?: readonly string[];
  notes?: string | null;
}

export interface CustomerContact {
  id: string;
  customerId: string;
  name: string;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  notes: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactInput {
  name: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  isPrimary?: boolean;
  notes?: string | null;
}

export interface CustomerQuery {
  /** Words from the name, account number, email, phone, city or postcode. Prefixes match. */
  text?: string;
  statuses?: readonly CustomerStatus[];
  /** All must be present. */
  tags?: readonly string[];
  /** The last row of the previous page. */
  after?: { name: string; id: string };
  limit?: number;
}

export interface CustomerPage {
  items: Customer[];
  next: { name: string; id: string } | undefined;
}

/** Tags are compared as people type them: trimmed, lower case, one of each. */
export function normaliseTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== ''))];
}

/**
 * A words-with-prefixes tsquery from what someone typed into a search box:
 * `boil serv` finds "Boiler service". Anything but letters and digits is a
 * separator, so nothing typed can be tsquery syntax.
 */
export function prefixQuery(text: string): string | undefined {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '')
    .slice(0, 8);
  return words.length === 0 ? undefined : words.map((word) => `${word}:*`).join(' & ');
}

const blank = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();

/**
 * Customers and their contacts, for one company.
 *
 * Nothing is deleted: a customer is closed, a contact archived, because work
 * orders and submissions keep pointing at both.
 */
export class CustomersRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #customers() {
    return this.db.selectFrom('customers').where('customers.tenant_id', '=', this.tenantId);
  }

  async create(input: CustomerInput, createdBy: UserId | string): Promise<Customer> {
    const row = await this.db
      .insertInto('customers')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...customerColumns(input),
        name: input.name.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCustomer(row);
  }

  async update(customerId: string, input: Partial<CustomerInput>): Promise<Customer | undefined> {
    const columns = customerColumns(input);
    if (Object.keys(columns).length === 0) {
      return this.find(customerId);
    }
    const row = await this.db
      .updateTable('customers')
      .set(columns)
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', customerId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toCustomer(row);
  }

  async find(customerId: string): Promise<Customer | undefined> {
    const row = await this.#customers().selectAll().where('id', '=', customerId).executeTakeFirst();
    return row === undefined ? undefined : toCustomer(row);
  }

  async findMany(customerIds: readonly string[]): Promise<Customer[]> {
    if (customerIds.length === 0) {
      return [];
    }
    return (
      await this.#customers()
        .selectAll()
        .where('id', 'in', [...new Set(customerIds)])
        .execute()
    ).map(toCustomer);
  }

  /** By account number, case-insensitively, as an import names a customer. */
  async findByAccountNumber(accountNumber: string): Promise<Customer | undefined> {
    const row = await this.#customers()
      .selectAll()
      .where(sql<boolean>`lower(account_number) = lower(${accountNumber.trim()})`)
      .executeTakeFirst();
    return row === undefined ? undefined : toCustomer(row);
  }

  /** By exact name, case-insensitively. More than one match is ambiguous and returns them all. */
  async findByName(name: string): Promise<Customer[]> {
    return (
      await this.#customers()
        .selectAll()
        .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
        .limit(2)
        .execute()
    ).map(toCustomer);
  }

  /** Alphabetical, a page at a time. */
  async list(query: CustomerQuery = {}): Promise<CustomerPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    let select = this.#customers().selectAll();

    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    const tags = normaliseTags(query.tags ?? []);
    if (tags.length > 0) {
      select = select.where(sql<boolean>`tags @> ${sql.val(tags)}::text[]`);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(lower(name), id) > (lower(${query.after.name}), ${query.after.id}::uuid)`,
      );
    }

    const rows = await select
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toCustomer);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined ? { name: last.name, id: last.id } : undefined,
    };
  }

  /** Every tag in use, most used first. For the filter's suggestions. */
  async tagsInUse(limit = 100): Promise<{ tag: string; customers: number }[]> {
    const rows = await this.db
      .selectFrom(
        this.#customers()
          .select(sql<string>`unnest(tags)`.as('tag'))
          .as('tagged'),
      )
      .select(['tagged.tag', sql<string>`count(*)`.as('customers')])
      .groupBy('tagged.tag')
      .orderBy(sql`count(*)`, 'desc')
      .orderBy('tagged.tag')
      .limit(limit)
      .execute();
    return rows.map((row) => ({ tag: row.tag, customers: Number(row.customers) }));
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  async addContact(customerId: string, input: ContactInput): Promise<CustomerContact> {
    if (input.isPrimary === true) {
      await this.#clearPrimary(customerId);
    }
    const row = await this.db
      .insertInto('customer_contacts')
      .values({
        tenant_id: this.tenantId,
        customer_id: customerId,
        ...contactColumns(input),
        name: input.name.trim(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toContact(row);
  }

  async updateContact(
    customerId: string,
    contactId: string,
    input: Partial<ContactInput>,
  ): Promise<CustomerContact | undefined> {
    if (input.isPrimary === true) {
      await this.#clearPrimary(customerId, contactId);
    }
    const columns = contactColumns(input);
    let update = this.db
      .updateTable('customer_contacts')
      .where('tenant_id', '=', this.tenantId)
      .where('customer_id', '=', customerId)
      .where('id', '=', contactId);
    if (Object.keys(columns).length === 0) {
      return (await this.listContacts(customerId, { includeArchived: true })).find(
        (contact) => contact.id === contactId,
      );
    }
    if (input.isPrimary === true) {
      update = update.where('archived_at', 'is', null);
    }
    const row = await update.set(columns).returningAll().executeTakeFirst();
    return row === undefined ? undefined : toContact(row);
  }

  async archiveContact(
    customerId: string,
    contactId: string,
  ): Promise<CustomerContact | undefined> {
    const row = await this.db
      .updateTable('customer_contacts')
      .set({ archived_at: sql<Date>`coalesce(archived_at, now())`, is_primary: false })
      .where('tenant_id', '=', this.tenantId)
      .where('customer_id', '=', customerId)
      .where('id', '=', contactId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toContact(row);
  }

  async listContacts(
    customerId: string,
    options: { includeArchived?: boolean } = {},
  ): Promise<CustomerContact[]> {
    let select = this.db
      .selectFrom('customer_contacts')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('customer_id', '=', customerId);
    if (options.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    return (
      await select
        .orderBy('is_primary', 'desc')
        .orderBy(sql`lower(name)`)
        .execute()
    ).map(toContact);
  }

  async findContacts(contactIds: readonly string[]): Promise<CustomerContact[]> {
    if (contactIds.length === 0) {
      return [];
    }
    return (
      await this.db
        .selectFrom('customer_contacts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', 'in', [...new Set(contactIds)])
        .execute()
    ).map(toContact);
  }

  async #clearPrimary(customerId: string, except?: string) {
    let update = this.db
      .updateTable('customer_contacts')
      .set({ is_primary: false })
      .where('tenant_id', '=', this.tenantId)
      .where('customer_id', '=', customerId)
      .where('is_primary', '=', true);
    if (except !== undefined) {
      update = update.where('id', '<>', except);
    }
    await update.execute();
  }
}

function customerColumns(input: Partial<CustomerInput>) {
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.accountNumber === undefined ? {} : { account_number: blank(input.accountNumber) }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.email === undefined ? {} : { email: blank(input.email) }),
    ...(input.phone === undefined ? {} : { phone: blank(input.phone) }),
    ...(input.tags === undefined ? {} : { tags: normaliseTags(input.tags) }),
    ...(input.notes === undefined ? {} : { notes: blank(input.notes) }),
    ...addressColumns(input.address),
  };
}

export function addressColumns(address: Partial<Address> | undefined) {
  if (address === undefined) {
    return {};
  }
  return {
    ...(address.line1 === undefined ? {} : { address_line1: blank(address.line1) }),
    ...(address.line2 === undefined ? {} : { address_line2: blank(address.line2) }),
    ...(address.city === undefined ? {} : { city: blank(address.city) }),
    ...(address.region === undefined ? {} : { region: blank(address.region) }),
    ...(address.postcode === undefined ? {} : { postcode: blank(address.postcode) }),
    ...(address.countryCode === undefined
      ? {}
      : { country_code: blank(address.countryCode)?.toUpperCase() ?? null }),
  };
}

function contactColumns(input: Partial<ContactInput>) {
  return {
    ...(input.name === undefined ? {} : { name: input.name.trim() }),
    ...(input.jobTitle === undefined ? {} : { job_title: blank(input.jobTitle) }),
    ...(input.email === undefined ? {} : { email: blank(input.email) }),
    ...(input.phone === undefined ? {} : { phone: blank(input.phone) }),
    ...(input.isPrimary === undefined ? {} : { is_primary: input.isPrimary }),
    ...(input.notes === undefined ? {} : { notes: blank(input.notes) }),
  };
}

function toCustomer(row: Selectable<CustomersTable>): Customer {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    name: row.name,
    accountNumber: row.account_number,
    status: row.status,
    email: row.email,
    phone: row.phone,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postcode: row.postcode,
      countryCode: row.country_code,
    },
    tags: row.tags,
    notes: row.notes,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toContact(row: Selectable<CustomerContactsTable>): CustomerContact {
  return {
    id: row.id,
    customerId: row.customer_id,
    name: row.name,
    jobTitle: row.job_title,
    email: row.email,
    phone: row.phone,
    isPrimary: row.is_primary,
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
