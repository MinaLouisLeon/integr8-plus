import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { GeocodeStatus, SitesTable } from '../schema.js';
import { type Address, prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * What an engineer needs to know before they arrive. The most-read part of a
 * job, so each concern has its own field rather than one box of free text.
 */
export interface AccessNotes {
  gateCode: string | null;
  parking: string | null;
  askFor: string | null;
  hazards: string | null;
  notes: string | null;
  updatedAt: Date | null;
  updatedBy: UserId | null;
}

export interface SiteLocation {
  latitude: number;
  longitude: number;
}

export interface Site {
  id: string;
  tenantId: TenantId;
  customerId: string;
  name: string;
  address: Address & { line1: string };
  location: SiteLocation | null;
  geocodeStatus: GeocodeStatus;
  geocodeAccuracy: string | null;
  geocodedAt: Date | null;
  contactId: string | null;
  access: AccessNotes;
  archivedAt: Date | null;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface SiteInput {
  name: string;
  address: Partial<Address> & { line1: string };
  contactId?: string | null;
  access?: Partial<Omit<AccessNotes, 'updatedAt' | 'updatedBy'>>;
  /** Placed by a person: kept, and not replaced by the geocoder, until the address changes. */
  location?: SiteLocation | null;
}

export interface SiteQuery {
  customerId?: string;
  text?: string;
  includeArchived?: boolean;
  after?: { name: string; id: string };
  limit?: number;
}

export interface GeocodeResult {
  location: SiteLocation;
  accuracy: string;
}

const blank = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.trim() === '' ? null : value.trim();

/** The address as one line, the way a geocoder and a person both read it. */
export function addressLine(address: Partial<Address>): string {
  return [
    address.line1,
    address.line2,
    address.city,
    address.region,
    address.postcode,
    address.countryCode,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
}

/**
 * Sites for one company. A site belongs to its customer for good, and a changed
 * address puts it back in the geocoder's queue — both enforced by migration 0010.
 */
export class SitesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #sites() {
    return this.db.selectFrom('sites').where('sites.tenant_id', '=', this.tenantId);
  }

  async create(customerId: string, input: SiteInput, createdBy: UserId | string): Promise<Site> {
    const row = await this.db
      .insertInto('sites')
      .values({
        tenant_id: this.tenantId,
        customer_id: customerId,
        created_by: toUserId(createdBy),
        name: input.name.trim(),
        ...siteAddressColumns(input.address),
        address_line1: input.address.line1.trim(),
        ...(input.contactId === undefined ? {} : { contact_id: input.contactId }),
        ...accessColumns(input.access, createdBy),
        ...locationColumns(input.location),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSite(row);
  }

  async update(
    siteId: string,
    input: Partial<Omit<SiteInput, 'address'>> & { address?: Partial<SiteInput['address']> },
    actor: UserId | string,
  ): Promise<Site | undefined> {
    const columns = {
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...siteAddressColumns(input.address),
      ...(input.contactId === undefined ? {} : { contact_id: input.contactId }),
      ...accessColumns(input.access, actor),
      ...locationColumns(input.location),
    };
    if (Object.keys(columns).length === 0) {
      return this.find(siteId);
    }
    const row = await this.db
      .updateTable('sites')
      .set(columns)
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', siteId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSite(row);
  }

  async setArchived(siteId: string, archived: boolean): Promise<Site | undefined> {
    const row = await this.db
      .updateTable('sites')
      .set({ archived_at: archived ? sql<Date>`coalesce(archived_at, now())` : null })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', siteId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSite(row);
  }

  async find(siteId: string): Promise<Site | undefined> {
    const row = await this.#sites().selectAll().where('id', '=', siteId).executeTakeFirst();
    return row === undefined ? undefined : toSite(row);
  }

  async findMany(siteIds: readonly string[]): Promise<Site[]> {
    if (siteIds.length === 0) {
      return [];
    }
    return (
      await this.#sites()
        .selectAll()
        .where('id', 'in', [...new Set(siteIds)])
        .execute()
    ).map(toSite);
  }

  /** A customer's site by name, case-insensitively, as an import names one. */
  async findByName(customerId: string, name: string): Promise<Site[]> {
    return (
      await this.#sites()
        .selectAll()
        .where('customer_id', '=', customerId)
        .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
        .limit(2)
        .execute()
    ).map(toSite);
  }

  async list(
    query: SiteQuery = {},
  ): Promise<{ items: Site[]; next: { name: string; id: string } | undefined }> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    let select = this.#sites().selectAll();
    if (query.customerId !== undefined) {
      select = select.where('customer_id', '=', query.customerId);
    }
    if (query.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
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
    const items = rows.slice(0, limit).map(toSite);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined ? { name: last.name, id: last.id } : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Geocoding
  // -------------------------------------------------------------------------

  async listPendingGeocode(limit = 50): Promise<Site[]> {
    return (
      await this.#sites()
        .selectAll()
        .where('geocode_status', '=', 'pending')
        .orderBy('updated_at')
        .limit(limit)
        .execute()
    ).map(toSite);
  }

  /**
   * Records what the geocoder said, but only if the site still has the address
   * that was sent: an address changed while the lookup was out is looked up again.
   */
  async recordGeocode(
    siteId: string,
    geocodedAddress: string,
    result: GeocodeResult | 'not_found' | 'failed',
  ): Promise<Site | undefined> {
    const site = await this.find(siteId);
    if (site?.geocodeStatus !== 'pending' || addressLine(site.address) !== geocodedAddress) {
      return undefined;
    }
    const columns =
      typeof result === 'string'
        ? { geocode_status: result, latitude: null, longitude: null, geocode_accuracy: null }
        : {
            geocode_status: 'found' as const,
            latitude: result.location.latitude,
            longitude: result.location.longitude,
            geocode_accuracy: result.accuracy,
          };
    const row = await this.db
      .updateTable('sites')
      .set({ ...columns, geocoded_at: sql<Date>`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', siteId)
      .where('geocode_status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toSite(row);
  }
}

/** A site always has a first address line; the API refuses a blank one before this. */
function siteAddressColumns(address: Partial<SiteInput['address']> | undefined) {
  if (address === undefined) {
    return {};
  }
  return {
    ...(address.line1 === undefined ? {} : { address_line1: address.line1.trim() }),
    ...(address.line2 === undefined ? {} : { address_line2: blank(address.line2) ?? null }),
    ...(address.city === undefined ? {} : { city: blank(address.city) ?? null }),
    ...(address.region === undefined ? {} : { region: blank(address.region) ?? null }),
    ...(address.postcode === undefined ? {} : { postcode: blank(address.postcode) ?? null }),
    ...(address.countryCode === undefined
      ? {}
      : { country_code: blank(address.countryCode)?.toUpperCase() ?? null }),
  };
}

function accessColumns(access: SiteInput['access'], actor: UserId | string) {
  if (access === undefined) {
    return {};
  }
  const columns = {
    ...(access.gateCode === undefined ? {} : { access_gate_code: blank(access.gateCode) }),
    ...(access.parking === undefined ? {} : { access_parking: blank(access.parking) }),
    ...(access.askFor === undefined ? {} : { access_ask_for: blank(access.askFor) }),
    ...(access.hazards === undefined ? {} : { access_hazards: blank(access.hazards) }),
    ...(access.notes === undefined ? {} : { access_notes: blank(access.notes) }),
  };
  return Object.keys(columns).length === 0
    ? {}
    : { ...columns, access_updated_by: toUserId(actor) };
}

function locationColumns(location: SiteLocation | null | undefined) {
  if (location === undefined) {
    return {};
  }
  if (location === null) {
    return {
      latitude: null,
      longitude: null,
      geocode_status: 'pending' as const,
      geocode_accuracy: null,
    };
  }
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    geocode_status: 'manual' as const,
    geocode_accuracy: 'manual',
    geocoded_at: sql<Date>`now()`,
  };
}

function toSite(row: Selectable<SitesTable>): Site {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    customerId: row.customer_id,
    name: row.name,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postcode: row.postcode,
      countryCode: row.country_code,
    },
    location:
      row.latitude === null || row.longitude === null
        ? null
        : { latitude: Number(row.latitude), longitude: Number(row.longitude) },
    geocodeStatus: row.geocode_status,
    geocodeAccuracy: row.geocode_accuracy,
    geocodedAt: row.geocoded_at,
    contactId: row.contact_id,
    access: {
      gateCode: row.access_gate_code,
      parking: row.access_parking,
      askFor: row.access_ask_for,
      hazards: row.access_hazards,
      notes: row.access_notes,
      updatedAt: row.access_updated_at,
      updatedBy: row.access_updated_by === null ? null : toUserId(row.access_updated_by),
    },
    archivedAt: row.archived_at,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
