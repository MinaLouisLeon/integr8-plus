import { randomBytes, randomUUID } from 'node:crypto';
import { getPlatformDataSource, MAX_LIVE_WEBSITE_KEYS, type WebsiteKey } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { hashWebsiteKey } from '../documents-public.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { requireStaffManager } from './staff.js';

/**
 * A company's website keys (docs/documents ADR-0001 D10, D11).
 *
 * The key lets the company's own website server look its documents up. Every
 * staff member may see that a key exists, its last characters and how much it
 * is used. Any active staff member may create, enable, disable or revoke
 * keys; only a staff manager — the account the terminal command made — may
 * physically delete one. The key itself is shown once, when it is made, and
 * stored only as its SHA-256. Two may be live at a time, so a website can move
 * to a new key before the old one is revoked.
 */

const TAGS = ['platform'];

const websiteKeySchema = z.object({
  id: z.uuid(),
  /** The key's last four characters, to tell keys apart. */
  hint: z.string(),
  label: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
  createdBy: z.string(),
  revokedAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  lookups: z.number().int(),
  found: z.number().int(),
});

const companyParams = z.object({ tenantId: z.uuid() });

async function names(): Promise<Map<string, string>> {
  return new Map(
    (await getPlatformDataSource().platformUsers.list()).map((account) => [
      account.id,
      account.displayName,
    ]),
  );
}

function keyBody(key: WebsiteKey, known: Map<string, string>): z.infer<typeof websiteKeySchema> {
  return {
    id: key.id,
    hint: key.keyHint,
    label: key.label,
    enabled: key.enabled,
    createdAt: iso(key.createdAt),
    createdBy: known.get(key.createdBy) ?? '',
    revokedAt: isoOrNull(key.revokedAt),
    lastUsedAt: isoOrNull(key.lastUsedAt),
    lookups: key.lookups,
    found: key.found,
  };
}

async function company(tenantId: string) {
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  if (tenant === undefined) {
    throw notFound('No such company.');
  }
  return tenant;
}

export const listWebsiteKeysRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/website-keys',
  operationId: 'listWebsiteKeys',
  summary: 'A company’s website keys, newest first',
  description:
    'Every key, revoked ones included, with its last characters and use. Never the key itself. `canManage` says whether this account may create, enable, disable or revoke keys; `canDelete` is reserved for the terminal-created staff admin.',
  tags: TAGS,
  security: 'platform',
  params: companyParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The keys.',
      schema: z.object({
        items: z.array(websiteKeySchema),
        canManage: z.boolean(),
        canDelete: z.boolean(),
        maxLive: z.number().int(),
      }),
    },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    await company(params.tenantId);
    const platform = getPlatformDataSource();
    const [keys, known, me] = await Promise.all([
      platform.websiteKeys.listForTenant(params.tenantId),
      names(),
      platform.platformUsers.findById(context.platform.platformUserId),
    ]);
    return {
      status: 200,
      body: {
        items: keys.map((key) => keyBody(key, known)),
        canManage: me?.isActive === true,
        canDelete: me?.canManageStaff === true && me.isActive,
        maxLive: MAX_LIVE_WEBSITE_KEYS,
      },
    };
  },
});

export const createWebsiteKeyRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/website-keys',
  operationId: 'createWebsiteKey',
  summary: 'Make a website key for a company',
  description:
    'Any signed-in Integr8 staff member may create a key. The key is in this answer and nowhere else: put it in the website’s server environment, never in its pages. Refused with 409 `website_key_limit` while the company already has two non-revoked keys.',
  tags: TAGS,
  security: 'platform',
  params: companyParams,
  query: noSchema,
  body: z.object({ label: z.string().trim().min(1).max(80).nullable().default(null) }),
  responses: {
    201: {
      description: 'The new key, and the secret, once.',
      schema: z.object({ key: websiteKeySchema, secret: z.string() }),
    },
    404: { description: 'No such company.' },
    409: { description: 'Two keys are already live (`website_key_limit`).' },
  },
  handler: async ({ params, body }, context) => {
    const tenant = await company(params.tenantId);
    const platform = getPlatformDataSource();
    if ((await platform.websiteKeys.liveCount(tenant.id)) >= MAX_LIVE_WEBSITE_KEYS) {
      throw conflict(
        'website_key_limit',
        'This company already has two live website keys. Revoke one before making another.',
      );
    }
    const secret = `i8wk_${randomBytes(32).toString('base64url')}`;
    const key = await platform.websiteKeys.create({
      id: randomUUID(),
      tenantId: tenant.id,
      keyHash: hashWebsiteKey(secret),
      keyHint: secret.slice(-4),
      label: body.label,
      createdBy: context.platform.platformUserId,
    });
    await recordPlatformAction(context, {
      action: 'website_key.created',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'website_key',
      targetId: key.id,
      metadata: { hint: key.keyHint, label: key.label },
    });
    return { status: 201, body: { key: keyBody(key, await names()), secret } };
  },
});

export const revokeWebsiteKeyRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/website-keys/:keyId/revoke',
  operationId: 'revokeWebsiteKey',
  summary: 'Revoke a website key',
  description:
    'Any signed-in Integr8 staff member may revoke a key. The website using it stops serving immediately. The key stays listed, revoked, for the record.',
  tags: TAGS,
  security: 'platform',
  params: companyParams.extend({ keyId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The revoked key.', schema: websiteKeySchema },
    404: { description: 'No such live key for this company.' },
  },
  handler: async ({ params }, context) => {
    const tenant = await company(params.tenantId);
    const revoked = await getPlatformDataSource().websiteKeys.revoke(
      tenant.id,
      params.keyId,
      context.platform.platformUserId,
    );
    if (revoked === undefined) {
      throw notFound('No such live key for this company.');
    }
    await recordPlatformAction(context, {
      action: 'website_key.revoked',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'website_key',
      targetId: revoked.id,
      metadata: { hint: revoked.keyHint },
    });
    return { status: 200, body: keyBody(revoked, await names()) };
  },
});

export const updateWebsiteKeyRoute = defineRoute({
  method: 'patch',
  path: '/v1/platform/companies/:tenantId/website-keys/:keyId',
  operationId: 'updateWebsiteKey',
  summary: 'Enable or disable a company website key',
  description: 'Any active Integr8 staff member can change key state. Disabling stops requests while retaining the key; enabling resumes it unless revoked.',
  tags: TAGS,
  security: 'platform',
  params: companyParams.extend({ keyId: z.uuid() }),
  query: noSchema,
  body: z.object({ enabled: z.boolean() }),
  responses: {
    200: { description: 'The updated key.', schema: websiteKeySchema },
    404: { description: 'No such active key for this company.' },
  },
  handler: async ({ params, body }, context) => {
    const tenant = await company(params.tenantId);
    const updated = await getPlatformDataSource().websiteKeys.setEnabled(
      tenant.id,
      params.keyId,
      body.enabled,
    );
    if (updated === undefined) throw notFound('No such active key for this company.');
    await recordPlatformAction(context, {
      action: body.enabled ? 'website_key.enabled' : 'website_key.disabled',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'website_key',
      targetId: updated.id,
      metadata: { hint: updated.keyHint },
    });
    return { status: 200, body: keyBody(updated, await names()) };
  },
});

export const deleteWebsiteKeyRoute = defineRoute({
  method: 'delete',
  path: '/v1/platform/companies/:tenantId/website-keys/:keyId',
  operationId: 'deleteWebsiteKey',
  summary: 'Permanently delete a company website key',
  description: 'Only the terminal-created Integr8 staff admin can permanently delete a key. An audit event records the action; the secret is never retained.',
  tags: TAGS,
  security: 'platform',
  params: companyParams.extend({ keyId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The removed key summary.', schema: websiteKeySchema },
    403: { description: 'Not the terminal-created Integr8 staff admin (staff_manager_only).' },
    404: { description: 'No such key for this company.' },
  },
  handler: async ({ params }, context) => {
    await requireStaffManager(context);
    const tenant = await company(params.tenantId);
    const removed = await getPlatformDataSource().websiteKeys.delete(tenant.id, params.keyId);
    if (removed === undefined) throw notFound('No such key for this company.');
    await recordPlatformAction(context, {
      action: 'website_key.deleted',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'website_key',
      targetId: removed.id,
      metadata: { hint: removed.keyHint, label: removed.label },
    });
    return { status: 200, body: keyBody(removed, await names()) };
  },
});

export const platformWebsiteKeyRoutes = [
  listWebsiteKeysRoute,
  createWebsiteKeyRoute,
  updateWebsiteKeyRoute,
  revokeWebsiteKeyRoute,
  deleteWebsiteKeyRoute,
];
