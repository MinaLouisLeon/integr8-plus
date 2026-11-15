import type { Kysely } from 'kysely';
import { toTenantId, type TenantId } from '@integr8/core';
import type { Database } from '../schema.js';

/**
 * Which company a printed asset tag belongs to, for the public page its QR
 * code opens (P42, D5).
 *
 * On the platform connection: a tag is scanned by whoever holds the sticker,
 * before anybody signs in. Tag codes are unique across every company
 * (`erp_assets_tag_code_unique`), so a code names one company at most. Only
 * the company is answered, never the asset: the page says whose tag it is
 * and to scan it with that company's phone app.
 */
export class PublicAssetTagsLookup {
  constructor(private readonly db: Kysely<Database>) {}

  async companyOf(tagCode: string): Promise<TenantId | undefined> {
    const row = await this.db
      .selectFrom('erp_assets')
      .innerJoin('tenants', 'tenants.id', 'erp_assets.tenant_id')
      .select('erp_assets.tenant_id')
      .where('erp_assets.tag_code', '=', tagCode)
      .where('tenants.deleted_at', 'is', null)
      .where('tenants.status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : toTenantId(row.tenant_id);
  }
}
