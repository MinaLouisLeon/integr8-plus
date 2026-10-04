import { type Kysely, type Selectable, sql } from 'kysely';
import type { Database, SignupEventsTable, SignupRequestsTable, SignupStatus } from '../schema.js';

/**
 * Somebody asking for a company, before there is one (P18).
 *
 * On the platform connection, necessarily: every row here describes a person
 * who is not yet a customer, and most describe attempts that never became one.
 * That is also why the funnel cannot live in `audit_log` — that table is
 * tenant-scoped, and a signup abandoned at the second step has no tenant to
 * scope it to.
 *
 * The token is stored only as a hash. Holding it is what creates a company, so
 * it is treated exactly as an invitation token is.
 */

export interface SignupRequest {
  id: string;
  email: string;
  companyName: string;
  status: SignupStatus;
  expiresAt: Date;
  verifiedAt: Date | null;
  tenantId: string | null;
  createdAt: Date;
}

export interface SignupEvent {
  id: string;
  step: string;
  signupId: string | null;
  tenantId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

/** One step of the funnel, with how many attempts reached it. */
export interface FunnelStep {
  step: string;
  count: number;
}

export class SignupRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: {
    email: string;
    companyName: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SignupRequest> {
    const row = await this.db
      .insertInto('signup_requests')
      .values({
        email: input.email.trim().toLowerCase(),
        company_name: input.companyName.trim(),
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent?.slice(0, 500) ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRequest(row);
  }

  async findByTokenHash(tokenHash: string): Promise<SignupRequest | undefined> {
    const row = await this.db
      .selectFrom('signup_requests')
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    return row === undefined ? undefined : toRequest(row);
  }

  /** The most recent request for an address, to rate-limit and to resend. */
  async findLatestByEmail(email: string): Promise<SignupRequest | undefined> {
    const row = await this.db
      .selectFrom('signup_requests')
      .selectAll()
      .where(sql<string>`lower(email)`, '=', email.trim().toLowerCase())
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    return row === undefined ? undefined : toRequest(row);
  }

  /** How many requests an address has made since a moment. Abuse control. */
  async countSince(email: string, since: Date): Promise<number> {
    const row = await this.db
      .selectFrom('signup_requests')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where(sql<string>`lower(email)`, '=', email.trim().toLowerCase())
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow();

    return Number(row.count);
  }

  /**
   * Takes the request for one verify, before anything is provisioned.
   *
   * `pending` → `verifying`, in one statement, so two clicks on the same link —
   * which is what a mail client that prefetches links produces — create one
   * company rather than two. The second finds no pending row to claim and is
   * told the link is spent. Claiming *before* provisioning rather than after is
   * the whole fix (0020): a check-then-provision-then-mark order let both
   * clicks past the check, and with the real identity provider the second one
   * failed on a duplicate address and left the request pending for ever.
   *
   * False when the request is not pending or has expired.
   */
  async claim(id: string, now = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable('signup_requests')
      .set({ status: 'verifying' })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Gives a claim back after provisioning failed, so the same link still works.
   *
   * `verifying` → `pending`, and nothing else: the token, the expiry and the
   * resend count are as they were. Nothing was made, so there is nothing to
   * name.
   */
  async release(id: string): Promise<boolean> {
    const result = await this.db
      .updateTable('signup_requests')
      .set({ status: 'pending' })
      .where('id', '=', id)
      .where('status', '=', 'verifying')
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Marks a claimed request verified and names the company it made.
   *
   * Conditional on the claim this verify holds: only a `verifying` row moves,
   * so a request that was somehow released or expired underneath cannot be
   * marked as having made a company it did not.
   */
  async markVerified(id: string, tenantId: string, now = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable('signup_requests')
      .set({ status: 'verified', verified_at: now, tenant_id: tenantId })
      .where('id', '=', id)
      .where('status', '=', 'verifying')
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Rotates the token, for a resend. The old link stops working. */
  /**
   * Replaces the token, counting the resend against the request's cap.
   *
   * One statement, so two resends racing cannot both pass the cap. False when
   * the request is no longer pending or has had its `maxResends`. The expiry is
   * deliberately left alone: a resend is the same link sent again.
   */
  async rotateToken(id: string, tokenHash: string, maxResends: number): Promise<boolean> {
    const result = await this.db
      .updateTable('signup_requests')
      .set({ token_hash: tokenHash, resend_count: sql<number>`resend_count + 1` })
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .where('resend_count', '<', maxResends)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Ages out requests nobody verified. Nothing was created, so nothing is lost. */
  async expireOverdue(now = new Date()): Promise<number> {
    const result = await this.db
      .updateTable('signup_requests')
      .set({ status: 'expired' })
      .where('status', '=', 'pending')
      .where('expires_at', '<', now)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n);
  }

  async recent(limit = 50): Promise<SignupRequest[]> {
    return (
      await this.db
        .selectFrom('signup_requests')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toRequest);
  }

  // -------------------------------------------------------------------------
  // The funnel
  // -------------------------------------------------------------------------

  /**
   * Records a step.
   *
   * Never throws into the caller's path: an analytics write that fails a signup
   * is a worse outcome than a gap in a chart, so the route wraps this and the
   * failure is logged rather than raised.
   */
  async recordEvent(input: {
    step: string;
    signupId?: string | null;
    tenantId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db
      .insertInto('signup_events')
      .values({
        step: input.step,
        signup_id: input.signupId ?? null,
        tenant_id: input.tenantId ?? null,
        metadata: JSON.stringify(input.metadata ?? {}) as never,
      })
      .execute();
  }

  /**
   * How many attempts reached each step, over a window.
   *
   * Counted as **distinct signups per step**, not rows: a visitor who reloads
   * the pricing page four times is one attempt that reached pricing, and
   * counting the reloads would make the top of the funnel meaningless. Steps
   * before a signup row exists have no id to be distinct on, so those count
   * rows — which is the honest best available and is why the first step is
   * labelled "visits" rather than "people".
   */
  async funnel(since: Date): Promise<FunnelStep[]> {
    const rows = await this.db
      .selectFrom('signup_events')
      .select((eb) => [
        'step',
        eb.fn.count<string>(sql`distinct signup_id`).as('attempts'),
        eb.fn.countAll<string>().as('rows'),
      ])
      .where('occurred_at', '>=', since)
      .groupBy('step')
      .execute();

    // `count(distinct ...)` ignores nulls, so a step recorded before any signup
    // row exists counts zero attempts. Falling back to the row count there is
    // the honest best available — and the reason the first step is labelled
    // "visits" rather than "people".
    return rows.map((row) => {
      const attempts = Number(row.attempts);
      return { step: row.step, count: attempts === 0 ? Number(row.rows) : attempts };
    });
  }

  async recentEvents(limit = 200): Promise<SignupEvent[]> {
    return (
      await this.db
        .selectFrom('signup_events')
        .selectAll()
        .orderBy('occurred_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toEvent);
  }
}

function toRequest(row: Selectable<SignupRequestsTable>): SignupRequest {
  return {
    id: row.id,
    email: row.email,
    companyName: row.company_name,
    status: row.status,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
  };
}

function toEvent(row: Selectable<SignupEventsTable>): SignupEvent {
  return {
    id: row.id,
    step: row.step,
    signupId: row.signup_id,
    tenantId: row.tenant_id,
    metadata: row.metadata,
    occurredAt: row.occurred_at,
  };
}
