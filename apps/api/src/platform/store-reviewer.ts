import { randomBytes } from 'node:crypto';
import { formatWorkOrderReference, toTenantId, toUserId } from '@integr8/core';
import type { IdentityProvider, SessionService } from '@integr8/auth';
import { withTenant } from '@integr8/db';
import { conflict, notFound } from '../http/errors.js';

/**
 * The app stores' reviewer account for one company (0023).
 *
 * Google Play and the App Store both review a phone app before it goes
 * public, and a company's app opens on a sign-in screen that only accepts
 * that company's people. So a company publishing in its own stores needs one
 * account for the reviewers: an engineer, with one made-up customer, site and
 * job on it, so they see the app working without seeing any real customer
 * (an engineer sees only the jobs they are on). Integr8 staff make it from
 * the company's page; it holds no seat, its role cannot be changed, and the
 * password is shown once, to be typed into each store's "App access" form.
 */

/**
 * The reviewer's address. Nobody reads its mail: it signs in with a password,
 * and the stores only need the address and password. One per company, so the
 * short name is in it; on Integr8's own domain, so a stray notification goes
 * to Integr8 rather than to somebody else's mailbox.
 */
export function storeReviewerEmail(slug: string): string {
  return `store-reviewer+${slug}@integr8-media.com`;
}

const DISPLAY_NAME = 'App store reviewer';

export interface StoreReviewerResult {
  /** False when the account already existed and only its password was replaced. */
  created: boolean;
  userId: string;
  email: string;
  /** Shown once. */
  password: string;
  /** The sample job's reference, when this call made it. */
  workOrderReference: string | null;
}

interface Who {
  /** The Integr8 staff member doing it, for the company's own audit log. */
  platformUserId: string;
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** 24 characters from 18 random bytes: well past the password policy, and nothing in it is the address. */
function newPassword(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Makes the company's reviewer account and its sample job, or, when it already
 * has one, gives it a new password and signs it out of every device.
 */
export async function makeStoreReviewer(input: {
  tenant: { id: string; slug: string };
  identity: IdentityProvider;
  sessions: SessionService;
  who: Who;
}): Promise<StoreReviewerResult> {
  const tenantId = toTenantId(input.tenant.id);
  const password = newPassword();
  const existing = await withTenant(tenantId, (tx) => tx.tenantUsers.findStoreReviewer());

  if (existing !== undefined) {
    await input.identity.setPassword(existing.userId, password);
    await input.sessions.revokeAllForUser(tenantId, existing.userId, 'password_changed');
    await withTenant(tenantId, (tx) =>
      tx.auditLog.append({
        ...actor(input.who),
        action: 'member.store_reviewer_password_set',
        resourceType: 'member',
        resourceId: existing.userId,
        metadata: { email: existing.email },
      }),
    );
    return {
      created: false,
      userId: existing.userId,
      email: existing.email,
      password,
      workOrderReference: null,
    };
  }

  const email = storeReviewerEmail(input.tenant.slug);
  // An account left from an earlier reviewer of this company keeps its id, so
  // anything it did still names it; it only gets the new password.
  const found = await input.identity.findByEmail(email);
  let userId: string;
  if (found === undefined) {
    userId = (await input.identity.createIdentity(email, password)).userId;
  } else {
    await input.identity.setPassword(found.userId, password);
    userId = found.userId;
  }

  const by = toUserId(input.who.platformUserId);
  const reference = await withTenant(tenantId, async (tx) => {
    if ((await tx.tenantUsers.findByEmail(email)) !== undefined) {
      throw conflict(
        'store_reviewer_email_taken',
        `${email} is already somebody in this company. Remove them first.`,
      );
    }
    await tx.tenantUsers.create({
      userId,
      email,
      displayName: DISPLAY_NAME,
      role: 'engineer',
      status: 'active',
      storeReviewer: true,
    });

    // The company's own first job type, so the job looks like its others; a
    // plain one when it has none yet.
    const jobType =
      (await tx.jobTypes.list())[0] ??
      (await tx.jobTypes.create(
        {
          name: 'Sample visit',
          code: 'SAMPLE',
          description: 'Made by Integr8 for the app stores’ reviewers.',
        },
        by,
      ));
    const customer = await tx.customers.create(
      {
        name: 'Sample customer (app review)',
        notes:
          'Made by Integr8 for the Google Play and App Store reviewers, who sign in as the “App store reviewer” engineer. Not a real customer.',
        tags: ['sample'],
      },
      by,
    );
    const site = await tx.sites.create(
      customer.id,
      { name: 'Sample site', address: { line1: '1 Sample Street', city: 'Cairo' } },
      by,
    );
    const now = new Date();
    const job = await tx.workOrders.create(
      {
        customerId: customer.id,
        siteId: site.id,
        jobTypeId: jobType.id,
        title: 'Sample job for the app review',
        description:
          'A made-up job so the app stores’ reviewers can see how a job is opened, worked and completed.',
        dueFrom: now,
        dueBy: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        crew: [{ userId, lead: true }],
      },
      by,
    );
    const formatted = formatWorkOrderReference(job.reference);
    await tx.auditLog.append({
      ...actor(input.who),
      action: 'member.store_reviewer_created',
      resourceType: 'member',
      resourceId: userId,
      metadata: { email, customerId: customer.id, workOrderId: job.id, reference: formatted },
    });
    return formatted;
  });

  return { created: true, userId, email, password, workOrderReference: reference };
}

/**
 * Takes the reviewer out of the company and signs it out. The sample customer
 * and job stay: they are the company's records now, to keep or delete.
 */
export async function removeStoreReviewer(input: {
  tenant: { id: string };
  sessions: SessionService;
  who: Who;
}): Promise<{ userId: string; email: string }> {
  const tenantId = toTenantId(input.tenant.id);
  const removed = await withTenant(tenantId, async (tx) => {
    const reviewer = await tx.tenantUsers.findStoreReviewer();
    if (reviewer === undefined) {
      return undefined;
    }
    await tx.tenantUsers.softDelete(reviewer.userId);
    await tx.auditLog.append({
      ...actor(input.who),
      action: 'member.store_reviewer_removed',
      resourceType: 'member',
      resourceId: reviewer.userId,
      metadata: { email: reviewer.email },
    });
    return reviewer;
  });
  if (removed === undefined) {
    throw notFound('This company has no store reviewer account.');
  }
  await input.sessions.revokeAllForUser(tenantId, removed.userId, 'revoked_by_admin');
  return { userId: removed.userId, email: removed.email };
}

function actor(who: Who) {
  return {
    actorKind: 'platform_user' as const,
    actorId: who.platformUserId,
    actorLabel: 'Integr8 staff',
    requestId: who.requestId,
    ipAddress: who.ipAddress,
    userAgent: who.userAgent,
  };
}
