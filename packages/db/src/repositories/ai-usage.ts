import { type TenantId, toTenantId, type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  AiCallPurpose,
  AiCallStatus,
  AiMessageReservationsTable,
  AiPeriodType,
  AiProviderCallsTable,
  AiReservationState,
  AiUsagePeriodsTable,
  AiUsageSubjectType,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Admitting and charging one assistant message (docs/ai; ADR-0001).
 *
 * The rule this file exists to keep: a message is charged when its answer is
 * durably stored, and never twice. Everything here is in service of that.
 *
 * - **The insert is the lock.** A chat request is identified by the member and
 *   their `Idempotency-Key`; the unique index on the three lets exactly one of
 *   any number of simultaneous callers insert the reservation, and the rest
 *   read what that one wrote: in progress, or a completed answer to replay.
 * - **Counters are locked in one order.** Company day, company month, member
 *   day, member month — always those four, always in that order, so two
 *   requests can never wait on each other. A counter that does not exist yet
 *   is inserted by the same statement that locks it.
 * - **Reserved counts against admission.** `used + reserved + 1 <= limit` or
 *   the whole transaction rolls back: a hundred requests at one slot left admit
 *   one, however they interleave.
 * - **Cost is reserved before the call and settled after.** In USD micros, as
 *   integers, from the company's monthly counter; the deployment's own counter
 *   is the platform's and is taken first, elsewhere.
 *
 * Every method runs in the caller's tenant transaction. A refusal is thrown,
 * because the reservation row has to go with it: the caller catches the error
 * outside `withTenant`, which has rolled back by then.
 */

export class AiQuotaExceededError extends Error {
  constructor(
    readonly axis: AiPeriodType,
    readonly subject: AiUsageSubjectType,
  ) {
    super(`The ${subject}'s ${axis} message quota is used up.`);
    this.name = 'AiQuotaExceededError';
  }
}

export class AiBudgetExceededError extends Error {
  constructor() {
    super("The company's monthly assistant budget is used up.");
    this.name = 'AiBudgetExceededError';
  }
}

/** A member's own monthly dollar cap, set by the platform, is used up (ADR-0002 D7). */
export class AiMemberBudgetExceededError extends Error {
  constructor() {
    super("The member's monthly assistant budget is used up.");
    this.name = 'AiMemberBudgetExceededError';
  }
}

/** The next model call's tokens would not fit in a company's or member's allowance (ADR-0002 D5). */
export class AiTokenQuotaExceededError extends Error {
  constructor(
    readonly axis: AiPeriodType,
    readonly subject: AiUsageSubjectType,
  ) {
    super(`The ${subject}'s ${axis} token allowance would be exceeded.`);
    this.name = 'AiTokenQuotaExceededError';
  }
}

export interface AiMessageReservation {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  conversationId: string;
  clientRequestId: string;
  requestFingerprint: string;
  state: AiReservationState;
  reservedCostMicrousd: number;
  settledCostMicrousd: number | null;
  providerAttempts: number;
  lastErrorCode: string | null;
  responseMessageId: string | null;
  createdAt: Date;
  expiresAt: Date;
  settledAt: Date | null;
  /** Tokens held for the call in flight, and used by the request's calls so far. */
  reservedTokens: number;
  usedTokens: number;
}

/** One counter: what a subject has used and has in flight in one period. */
export interface AiUsageCounter {
  subject: AiUsageSubjectType;
  period: AiPeriodType;
  /** `YYYY-MM-DD`. */
  periodStart: string;
  used: number;
  reserved: number;
}

/** The four counters a request touches, by the UTC periods `at` falls in. */
export interface AiPeriodKeys {
  day: string;
  month: string;
}

export interface ReserveAiMessageInput {
  userId: UserId | string;
  conversationId: string;
  clientRequestId: string;
  requestFingerprint: string;
  periods: AiPeriodKeys;
  /** Null on an axis means that axis is not limited. */
  limits: {
    tenantDaily: number | null;
    tenantMonthly: number | null;
    userDaily: number | null;
    userMonthly: number | null;
  };
  /** The worst case this message may cost, reserved against the month. */
  costMicrousd: number;
  /** Null means no company ceiling; the platform's own is checked elsewhere. */
  costCapMicrousd: number | null;
  /**
   * The member's own monthly ceiling, set by the platform (ADR-0002 D7).
   * Null means none. Their spend is attributed either way.
   */
  memberCostCapMicrousd?: number | null;
  expiresAt: Date;
}

/** The token limits a call is held against; null on an axis means not limited. */
export interface AiTokenLimits {
  tenantDaily: number | null;
  tenantMonthly: number | null;
  userDaily: number | null;
  userMonthly: number | null;
}

export type ReserveAiMessageOutcome =
  | { outcome: 'claimed'; reservation: AiMessageReservation }
  | { outcome: 'in_progress'; reservation: AiMessageReservation }
  | { outcome: 'replay'; reservation: AiMessageReservation }
  | { outcome: 'fingerprint_mismatch'; reservation: AiMessageReservation };

export interface SettleAiMessageInput {
  reservationId: string;
  outcome: 'completed' | 'released' | 'uncertain' | 'expired';
  /** The stored answer, when completed. */
  responseMessageId?: string | null;
  /** What the provider actually charged, as reported or estimated. */
  spentMicrousd: number;
  /** What was spent on calls whose cost the provider never confirmed. */
  unknownMicrousd?: number;
  errorCode?: string | null;
}

export interface RecordAiProviderCallInput {
  reservationId: string;
  provider: string;
  model: string;
  attemptNumber: number;
  purpose: AiCallPurpose;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  tokensEstimated: boolean;
  costMicrousd: number;
  priceVersion: string;
  status: AiCallStatus;
  errorCode?: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AiProviderCall {
  id: string;
  reservationId: string;
  provider: string;
  model: string;
  attemptNumber: number;
  purpose: AiCallPurpose;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensEstimated: boolean;
  costMicrousd: number;
  status: AiCallStatus;
  errorCode: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

/** Counter keys in the one order they are ever locked in. */
function counterKeys(
  tenantId: string,
  userId: string,
  periods: AiPeriodKeys,
): { subject: AiUsageSubjectType; subjectId: string; period: AiPeriodType; start: string }[] {
  return [
    { subject: 'tenant', subjectId: tenantId, period: 'day', start: periods.day },
    { subject: 'tenant', subjectId: tenantId, period: 'month', start: periods.month },
    { subject: 'user', subjectId: userId, period: 'day', start: periods.day },
    { subject: 'user', subjectId: userId, period: 'month', start: periods.month },
  ];
}

export class AiUsageRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * Admits one message, or says why not.
   *
   * On `claimed` the counters and the month's budget hold this message's
   * reservation, committed with the caller's transaction, before any provider
   * is called. A quota or budget refusal is thrown and takes the reservation
   * row with it.
   */
  async reserve(input: ReserveAiMessageInput): Promise<ReserveAiMessageOutcome> {
    const userId = toUserId(input.userId);
    const inserted = await this.db
      .insertInto('ai_message_reservations')
      .values({
        tenant_id: this.tenantId,
        user_id: userId,
        conversation_id: input.conversationId,
        client_request_id: input.clientRequestId,
        request_fingerprint: input.requestFingerprint,
        period_day: input.periods.day,
        period_month: input.periods.month,
        reserved_cost_microusd: input.costMicrousd,
        expires_at: input.expiresAt,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'user_id', 'client_request_id']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted === undefined) {
      const existing = await this.findByRequest(userId, input.clientRequestId);
      if (existing === undefined) {
        // Removed between the conflict and the read: only the sweeper does
        // that, to a row long settled. Treat it as in progress; the client
        // retries with the same key and gets a clean claim.
        throw new Error('ai_message_reservations: row vanished during claim');
      }
      if (existing.requestFingerprint !== input.requestFingerprint) {
        return { outcome: 'fingerprint_mismatch', reservation: existing };
      }
      return existing.state === 'completed'
        ? { outcome: 'replay', reservation: existing }
        : { outcome: 'in_progress', reservation: existing };
    }

    // The four counters, locked in order. `on conflict do update` takes the
    // row lock whether the row was just made or already there.
    const limitFor = {
      'tenant:day': input.limits.tenantDaily,
      'tenant:month': input.limits.tenantMonthly,
      'user:day': input.limits.userDaily,
      'user:month': input.limits.userMonthly,
    } as const;

    for (const key of counterKeys(this.tenantId, userId, input.periods)) {
      const row = await this.db
        .insertInto('ai_usage_periods')
        .values({
          tenant_id: this.tenantId,
          subject_type: key.subject,
          subject_id: key.subjectId,
          period_type: key.period,
          period_start_utc: key.start,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'subject_type', 'subject_id', 'period_type', 'period_start_utc'])
            .doUpdateSet({ updated_at: sql`now()` }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      const limit = limitFor[`${key.subject}:${key.period}`];
      if (limit !== null && row.used_messages + row.reserved_messages + 1 > limit) {
        throw new AiQuotaExceededError(key.period, key.subject);
      }

      await this.db
        .updateTable('ai_usage_periods')
        .set((eb) => ({
          reserved_messages: eb('reserved_messages', '+', 1),
          version: eb('version', '+', 1),
          updated_at: sql`now()`,
        }))
        .where('id', '=', row.id)
        .where('tenant_id', '=', this.tenantId)
        .execute();
    }

    // The month's budget, after the counters so a budget refusal never holds
    // a counter lock longer than it has to.
    const cost = await this.db
      .insertInto('ai_cost_periods')
      .values({ tenant_id: this.tenantId, period_start_utc: input.periods.month })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'period_start_utc']).doUpdateSet({ updated_at: sql`now()` }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    if (input.costCapMicrousd !== null) {
      const committed =
        micros(cost.reserved_microusd) +
        micros(cost.spent_microusd) +
        micros(cost.unknown_microusd);
      if (committed + input.costMicrousd > input.costCapMicrousd) {
        throw new AiBudgetExceededError();
      }
    }

    await this.db
      .updateTable('ai_cost_periods')
      .set({
        reserved_microusd: sql`reserved_microusd + ${input.costMicrousd}`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', '=', input.periods.month)
      .execute();

    // The member's share of the same money, after the company's: attributed
    // always, capped only when the platform set a cap (ADR-0002 D7).
    const member = await this.db
      .insertInto('ai_member_cost_periods')
      .values({ tenant_id: this.tenantId, user_id: userId, period_start_utc: input.periods.month })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'user_id', 'period_start_utc'])
          .doUpdateSet({ updated_at: sql`now()` }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    const memberCap = input.memberCostCapMicrousd ?? null;
    if (memberCap !== null) {
      const committed =
        micros(member.reserved_microusd) +
        micros(member.spent_microusd) +
        micros(member.unknown_microusd);
      if (committed + input.costMicrousd > memberCap) {
        throw new AiMemberBudgetExceededError();
      }
    }
    await this.db
      .updateTable('ai_member_cost_periods')
      .set({
        reserved_microusd: sql`reserved_microusd + ${input.costMicrousd}`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', userId)
      .where('period_start_utc', '=', input.periods.month)
      .execute();

    return { outcome: 'claimed', reservation: toReservation(inserted) };
  }

  /**
   * Settles a reservation once: converts its slot to used (completed), gives
   * it back (released, expired) or leaves it counted until a human looks
   * (uncertain — the answer may have been stored, so the slot is kept as
   * reserved and the cost as unknown). A second settlement changes nothing and
   * returns the row as it is.
   */
  async settle(input: SettleAiMessageInput): Promise<AiMessageReservation | undefined> {
    const current = await this.db
      .selectFrom('ai_message_reservations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .forUpdate()
      .executeTakeFirst();

    if (current === undefined) {
      return undefined;
    }
    if (current.state !== 'reserved' && current.state !== 'uncertain') {
      return toReservation(current);
    }
    // An uncertain row can only move on to completed or released by the
    // reconciler; it does not go uncertain twice.
    if (current.state === 'uncertain' && input.outcome === 'uncertain') {
      return toReservation(current);
    }

    const periods = { day: dayKey(current.period_day), month: dayKey(current.period_month) };
    const settlesSlot = input.outcome !== 'uncertain';
    // An uncertain row still holds its slot, so settling it gives the slot
    // back (or converts it) exactly as settling a reserved one does.
    const counterChange =
      input.outcome === 'completed'
        ? { used: 1, reserved: -1 }
        : settlesSlot
          ? { used: 0, reserved: -1 }
          : { used: 0, reserved: 0 };

    if (counterChange.used !== 0 || counterChange.reserved !== 0) {
      for (const key of counterKeys(this.tenantId, current.user_id, periods)) {
        await this.db
          .updateTable('ai_usage_periods')
          .set((eb) => ({
            used_messages: eb('used_messages', '+', counterChange.used),
            reserved_messages: sql`greatest(0, reserved_messages + ${counterChange.reserved})`,
            version: eb('version', '+', 1),
            updated_at: sql`now()`,
          }))
          .where('tenant_id', '=', this.tenantId)
          .where('subject_type', '=', key.subject)
          .where('subject_id', '=', key.subjectId)
          .where('period_type', '=', key.period)
          .where('period_start_utc', '=', key.start)
          .execute();
      }
    }

    // The money: whatever was reserved comes off, whatever was spent goes on.
    // An uncertain outcome keeps the reservation held as unknown until the
    // reconciler decides; it is released from `reserved` so a settled column
    // never counts it twice.
    const reserved = current.state === 'reserved' ? micros(current.reserved_cost_microusd) : 0;
    const unknown = input.unknownMicrousd ?? 0;
    await this.db
      .insertInto('ai_cost_periods')
      .values({ tenant_id: this.tenantId, period_start_utc: periods.month })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'period_start_utc']).doUpdateSet({ updated_at: sql`now()` }),
      )
      .execute();
    await this.db
      .updateTable('ai_cost_periods')
      .set({
        reserved_microusd: sql`greatest(0, reserved_microusd - ${reserved})`,
        spent_microusd: sql`spent_microusd + ${input.spentMicrousd}`,
        unknown_microusd: sql`greatest(0, unknown_microusd + ${unknown}${
          current.state === 'uncertain' ? sql` - ${micros(current.reserved_cost_microusd)}` : sql``
        })`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', '=', periods.month)
      .execute();

    // The same figures on the member's own ledger: one charge, attributed.
    await this.db
      .insertInto('ai_member_cost_periods')
      .values({
        tenant_id: this.tenantId,
        user_id: current.user_id,
        period_start_utc: periods.month,
      })
      .onConflict((oc) =>
        oc
          .columns(['tenant_id', 'user_id', 'period_start_utc'])
          .doUpdateSet({ updated_at: sql`now()` }),
      )
      .execute();
    await this.db
      .updateTable('ai_member_cost_periods')
      .set({
        reserved_microusd: sql`greatest(0, reserved_microusd - ${reserved})`,
        spent_microusd: sql`spent_microusd + ${input.spentMicrousd}`,
        unknown_microusd: sql`greatest(0, unknown_microusd + ${unknown}${
          current.state === 'uncertain' ? sql` - ${micros(current.reserved_cost_microusd)}` : sql``
        })`,
        updated_at: sql`now()`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', current.user_id)
      .where('period_start_utc', '=', periods.month)
      .execute();

    const row = await this.db
      .updateTable('ai_message_reservations')
      .set({
        state: input.outcome,
        settled_cost_microusd: input.spentMicrousd,
        response_message_id: input.responseMessageId ?? current.response_message_id,
        last_error_code: input.errorCode ?? current.last_error_code,
        settled_at: settlesSlot ? sql`now()` : null,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return toReservation(row);
  }

  // -------------------------------------------------------------------------
  // Tokens, held per model call (ADR-0002 D5)
  // -------------------------------------------------------------------------

  /**
   * Holds `tokens` for the next model call of an admitted request, against
   * the company's and the member's day and month, or throws
   * `AiTokenQuotaExceededError` and holds nothing.
   *
   * The four token counters are locked in the same order as the message
   * counters, so a hold can never wait on another in a cycle. Used plus held
   * plus this hold must fit every limited axis: two members asking at once
   * can never together pass the company's pool.
   */
  async holdTokens(input: {
    reservationId: string;
    tokens: number;
    limits: AiTokenLimits;
  }): Promise<void> {
    const reservation = await this.db
      .selectFrom('ai_message_reservations')
      .select(['user_id', 'period_day', 'period_month', 'state'])
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .forUpdate()
      .executeTakeFirst();
    if (reservation?.state !== 'reserved') {
      throw new Error('ai_message_reservations: no open reservation to hold tokens on');
    }
    const periods = {
      day: dayKey(reservation.period_day),
      month: dayKey(reservation.period_month),
    };
    const limitFor = {
      'tenant:day': input.limits.tenantDaily,
      'tenant:month': input.limits.tenantMonthly,
      'user:day': input.limits.userDaily,
      'user:month': input.limits.userMonthly,
    } as const;

    for (const key of counterKeys(this.tenantId, reservation.user_id, periods)) {
      const row = await this.db
        .insertInto('ai_token_periods')
        .values({
          tenant_id: this.tenantId,
          subject_type: key.subject,
          subject_id: key.subjectId,
          period_type: key.period,
          period_start_utc: key.start,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'subject_type', 'subject_id', 'period_type', 'period_start_utc'])
            .doUpdateSet({ updated_at: sql`now()` }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();

      const limit = limitFor[`${key.subject}:${key.period}`];
      if (
        limit !== null &&
        micros(row.used_tokens) + micros(row.reserved_tokens) + input.tokens > limit
      ) {
        throw new AiTokenQuotaExceededError(key.period, key.subject);
      }
      await this.db
        .updateTable('ai_token_periods')
        .set({
          reserved_tokens: sql`reserved_tokens + ${input.tokens}`,
          updated_at: sql`now()`,
        })
        .where('id', '=', row.id)
        .where('tenant_id', '=', this.tenantId)
        .execute();
    }

    await this.db
      .updateTable('ai_message_reservations')
      .set({ reserved_tokens: sql`reserved_tokens + ${input.tokens}` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .execute();
  }

  /**
   * Ends a call's hold: `held` comes off what is reserved, `used` goes on what
   * is used, on the four counters and the request alike. `used` may exceed
   * `held` when the provider reports more than was estimated; counters then
   * pass their limit and the next hold is refused, which is the honest
   * outcome. Never more is released than the request still holds.
   */
  async settleTokens(input: { reservationId: string; held: number; used: number }): Promise<void> {
    const reservation = await this.db
      .selectFrom('ai_message_reservations')
      .select(['user_id', 'period_day', 'period_month', 'reserved_tokens'])
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .forUpdate()
      .executeTakeFirst();
    if (reservation === undefined) {
      return;
    }
    const held = Math.min(Math.max(0, input.held), micros(reservation.reserved_tokens));
    const used = Math.max(0, input.used);
    if (held === 0 && used === 0) {
      return;
    }
    const periods = {
      day: dayKey(reservation.period_day),
      month: dayKey(reservation.period_month),
    };
    for (const key of counterKeys(this.tenantId, reservation.user_id, periods)) {
      await this.db
        .insertInto('ai_token_periods')
        .values({
          tenant_id: this.tenantId,
          subject_type: key.subject,
          subject_id: key.subjectId,
          period_type: key.period,
          period_start_utc: key.start,
          // A counter made here held nothing, so only the use lands on it.
          used_tokens: used,
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'subject_type', 'subject_id', 'period_type', 'period_start_utc'])
            .doUpdateSet({
              reserved_tokens: sql`greatest(0, ai_token_periods.reserved_tokens - ${held})`,
              used_tokens: sql`ai_token_periods.used_tokens + ${used}`,
              updated_at: sql`now()`,
            }),
        )
        .execute();
    }
    await this.db
      .updateTable('ai_message_reservations')
      .set({
        reserved_tokens: sql`greatest(0, reserved_tokens - ${held})`,
        used_tokens: sql`used_tokens + ${used}`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.reservationId)
      .execute();
  }

  /** The company's and one member's token counters for the periods given. Missing counters are zero. */
  async tokenCounters(userId: UserId | string, periods: AiPeriodKeys): Promise<AiUsageCounter[]> {
    const keys = counterKeys(this.tenantId, toUserId(userId), periods);
    const rows = await this.db
      .selectFrom('ai_token_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .where('subject_id', 'in', [this.tenantId, toUserId(userId)])
      .execute();
    return keys.map((key) => {
      const row = rows.find(
        (candidate) =>
          candidate.subject_type === key.subject &&
          candidate.subject_id === key.subjectId &&
          candidate.period_type === key.period &&
          dayKey(candidate.period_start_utc) === key.start,
      );
      return {
        subject: key.subject,
        period: key.period,
        periodStart: key.start,
        used: row === undefined ? 0 : micros(row.used_tokens),
        reserved: row === undefined ? 0 : micros(row.reserved_tokens),
      };
    });
  }

  /** Every member's token and message counters in the periods given, for the company's own view. */
  async memberCounters(periods: AiPeriodKeys): Promise<
    {
      userId: UserId;
      period: AiPeriodType;
      messagesUsed: number;
      messagesReserved: number;
      tokensUsed: number;
      tokensReserved: number;
    }[]
  > {
    const messages = await this.db
      .selectFrom('ai_usage_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('subject_type', '=', 'user')
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .execute();
    const tokens = await this.db
      .selectFrom('ai_token_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('subject_type', '=', 'user')
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .execute();
    const keyOf = (row: {
      subject_id: string;
      period_type: AiPeriodType;
      period_start_utc: string | Date;
    }) => `${row.subject_id}:${row.period_type}:${dayKey(row.period_start_utc)}`;
    const wanted = (row: { period_type: AiPeriodType; period_start_utc: string | Date }) =>
      dayKey(row.period_start_utc) === (row.period_type === 'day' ? periods.day : periods.month);
    const out = new Map<
      string,
      {
        userId: UserId;
        period: AiPeriodType;
        messagesUsed: number;
        messagesReserved: number;
        tokensUsed: number;
        tokensReserved: number;
      }
    >();
    const entry = (row: {
      subject_id: string;
      period_type: AiPeriodType;
      period_start_utc: string | Date;
    }) => {
      const key = keyOf(row);
      const existing = out.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = {
        userId: toUserId(row.subject_id),
        period: row.period_type,
        messagesUsed: 0,
        messagesReserved: 0,
        tokensUsed: 0,
        tokensReserved: 0,
      };
      out.set(key, created);
      return created;
    };
    for (const row of messages.filter(wanted)) {
      const target = entry(row);
      target.messagesUsed = row.used_messages;
      target.messagesReserved = row.reserved_messages;
    }
    for (const row of tokens.filter(wanted)) {
      const target = entry(row);
      target.tokensUsed = micros(row.used_tokens);
      target.tokensReserved = micros(row.reserved_tokens);
    }
    return [...out.values()];
  }

  /** One member's month on their own ledger, in USD micros: for the platform only. */
  async memberCostPeriod(
    userId: UserId | string,
    monthStart: string,
  ): Promise<{ reserved: number; spent: number; unknown: number }> {
    const row = await this.db
      .selectFrom('ai_member_cost_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('period_start_utc', '=', monthStart)
      .executeTakeFirst();
    return {
      reserved: micros(row?.reserved_microusd ?? 0),
      spent: micros(row?.spent_microusd ?? 0),
      unknown: micros(row?.unknown_microusd ?? 0),
    };
  }

  /** Every member's month on their own ledger: for the platform only. */
  async memberCostPeriods(
    monthStart: string,
  ): Promise<{ userId: UserId; reserved: number; spent: number; unknown: number }[]> {
    const rows = await this.db
      .selectFrom('ai_member_cost_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', '=', monthStart)
      .execute();
    return rows.map((row) => ({
      userId: toUserId(row.user_id),
      reserved: micros(row.reserved_microusd),
      spent: micros(row.spent_microusd),
      unknown: micros(row.unknown_microusd),
    }));
  }

  /** Counts a provider attempt against the reservation, for diagnostics and the reconciler. */
  async noteProviderAttempt(reservationId: string, errorCode: string | null): Promise<void> {
    await this.db
      .updateTable('ai_message_reservations')
      .set((eb) => ({
        provider_attempts: eb('provider_attempts', '+', 1),
        last_error_code: errorCode,
      }))
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', reservationId)
      .execute();
  }

  async find(reservationId: string): Promise<AiMessageReservation | undefined> {
    const row = await this.db
      .selectFrom('ai_message_reservations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', reservationId)
      .executeTakeFirst();
    return row === undefined ? undefined : toReservation(row);
  }

  async findByRequest(
    userId: UserId | string,
    clientRequestId: string,
  ): Promise<AiMessageReservation | undefined> {
    const row = await this.db
      .selectFrom('ai_message_reservations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('client_request_id', '=', clientRequestId)
      .executeTakeFirst();
    return row === undefined ? undefined : toReservation(row);
  }

  /** Reservations still open past their expiry: what the reconciler looks at. */
  async listStale(now: Date, limit = 100): Promise<AiMessageReservation[]> {
    const rows = await this.db
      .selectFrom('ai_message_reservations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('state', 'in', ['reserved', 'uncertain'])
      .where('expires_at', '<=', now)
      .orderBy('expires_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toReservation);
  }

  // -------------------------------------------------------------------------
  // Reading usage
  // -------------------------------------------------------------------------

  /** The company's and one member's counters for the periods `at` falls in. Missing counters are zero. */
  async counters(userId: UserId | string, periods: AiPeriodKeys): Promise<AiUsageCounter[]> {
    const keys = counterKeys(this.tenantId, toUserId(userId), periods);
    const rows = await this.db
      .selectFrom('ai_usage_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', 'in', [periods.day, periods.month])
      .where('subject_id', 'in', [this.tenantId, toUserId(userId)])
      .execute();

    return keys.map((key) => {
      const row = rows.find(
        (candidate) =>
          candidate.subject_type === key.subject &&
          candidate.subject_id === key.subjectId &&
          candidate.period_type === key.period &&
          dayKey(candidate.period_start_utc) === key.start,
      );
      return {
        subject: key.subject,
        period: key.period,
        periodStart: key.start,
        used: row?.used_messages ?? 0,
        reserved: row?.reserved_messages ?? 0,
      };
    });
  }

  /** The company's month: what is reserved, spent and unconfirmed, in USD micros. */
  async costPeriod(
    monthStart: string,
  ): Promise<{ reserved: number; spent: number; unknown: number }> {
    const row = await this.db
      .selectFrom('ai_cost_periods')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('period_start_utc', '=', monthStart)
      .executeTakeFirst();
    return {
      reserved: micros(row?.reserved_microusd ?? 0),
      spent: micros(row?.spent_microusd ?? 0),
      unknown: micros(row?.unknown_microusd ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Provider calls
  // -------------------------------------------------------------------------

  async recordProviderCall(input: RecordAiProviderCallInput): Promise<AiProviderCall> {
    const row = await this.db
      .insertInto('ai_provider_calls')
      .values({
        tenant_id: this.tenantId,
        reservation_id: input.reservationId,
        provider: input.provider,
        model: input.model,
        attempt_number: input.attemptNumber,
        purpose: input.purpose,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
        cached_tokens: input.cachedTokens ?? null,
        reasoning_tokens: input.reasoningTokens ?? null,
        tokens_estimated: input.tokensEstimated,
        cost_microusd: input.costMicrousd,
        price_version: input.priceVersion,
        status: input.status,
        error_code: input.errorCode ?? null,
        started_at: input.startedAt,
        ended_at: input.endedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCall(row);
  }

  async callsFor(reservationId: string): Promise<AiProviderCall[]> {
    const rows = await this.db
      .selectFrom('ai_provider_calls')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('reservation_id', '=', reservationId)
      .orderBy('attempt_number', 'asc')
      .execute();
    return rows.map(toCall);
  }
}

/** A bigint column as a number, which it always fits: a budget is not a national debt. */
export function micros(value: string | number | bigint): number {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(`USD micros out of range: ${String(value)}`);
  }
  return asNumber;
}

/**
 * A `date` column as `YYYY-MM-DD`. The driver hands a `date` back as a
 * JavaScript Date at local midnight, so the calendar fields are read in local
 * time, not UTC: a UTC read would be a day early anywhere east of Greenwich.
 */
export function dayKey(value: string | Date): string {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${String(value.getFullYear())}-${month}-${day}`;
  }
  return value.slice(0, 10);
}

function toReservation(row: Selectable<AiMessageReservationsTable>): AiMessageReservation {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    userId: toUserId(row.user_id),
    conversationId: row.conversation_id,
    clientRequestId: row.client_request_id,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    reservedCostMicrousd: micros(row.reserved_cost_microusd),
    settledCostMicrousd:
      row.settled_cost_microusd === null ? null : micros(row.settled_cost_microusd),
    providerAttempts: row.provider_attempts,
    lastErrorCode: row.last_error_code,
    responseMessageId: row.response_message_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    reservedTokens: micros(row.reserved_tokens),
    usedTokens: micros(row.used_tokens),
  };
}

function toCall(row: Selectable<AiProviderCallsTable>): AiProviderCall {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    provider: row.provider,
    model: row.model,
    attemptNumber: row.attempt_number,
    purpose: row.purpose,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    tokensEstimated: row.tokens_estimated,
    costMicrousd: micros(row.cost_microusd),
    status: row.status,
    errorCode: row.error_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export type { AiUsagePeriodsTable };
