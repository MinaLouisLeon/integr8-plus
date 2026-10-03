import type { Kysely, Selectable } from 'kysely';
import {
  type AccountLocksTable,
  type Database,
  type LoginOutcome,
  loginOutcomeSchema,
} from '../schema.js';

export interface LoginAttemptInput {
  email: string;
  outcome: LoginOutcome;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AccountLock {
  email: string;
  failedCount: number;
  lastFailureAt: Date | null;
  lockedAt: Date | null;
  lockedUntil: Date | null;
  unlockedAt: Date | null;
  unlockedBy: string | null;
  updatedAt: Date;
}

export interface LockPolicy {
  /** Consecutive failures before the address is locked. */
  threshold: number;
  /** How long a lock lasts without an admin lifting it. */
  lockDurationMs: number;
  /** Failures older than this no longer count towards the threshold. */
  windowMs: number;
}

/**
 * Sign-in attempts and lockout, across the whole platform.
 *
 * Not tenant-scoped, and it cannot be. At the moment an attempt fails, the
 * company is unknown — and for an address that belongs to nobody it is
 * unknowable. Keying lockout on the tenant would mean either leaking which
 * companies an address belongs to, or leaving each company to be brute-forced
 * separately.
 *
 * The price is that this reads across every company, so it is reached only by
 * the `integr8_auth` role, which can touch these two tables and one view and
 * nothing else. See migration 0003.
 */
export class LoginSecurityRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Records an attempt.
   *
   * Every attempt, including the successful ones: a successful sign-in from an
   * unfamiliar address at 03:00 is the only evidence that a stolen password was
   * used, and it is worth nothing if only failures were kept.
   */
  async recordAttempt(input: LoginAttemptInput): Promise<void> {
    await this.db
      .insertInto('login_attempts')
      .values({
        email: normalise(input.email),
        outcome: loginOutcomeSchema.parse(input.outcome),
        ip_address: input.ipAddress ?? null,
        user_agent: input.userAgent ?? null,
      })
      .execute();
  }

  /** Attempts against one address since `since`, newest first. */
  async recentAttempts(
    email: string,
    since: Date,
    limit = 50,
  ): Promise<{ outcome: LoginOutcome; occurredAt: Date; ipAddress: string | null }[]> {
    const rows = await this.db
      .selectFrom('login_attempts')
      .select(['outcome', 'occurred_at', 'ip_address'])
      .where('email', '=', normalise(email))
      .where('occurred_at', '>=', since)
      .orderBy('occurred_at', 'desc')
      .limit(limit)
      .execute();

    return rows.map((row) => ({
      outcome: loginOutcomeSchema.parse(row.outcome),
      occurredAt: row.occurred_at,
      ipAddress: row.ip_address,
    }));
  }

  /**
   * Attempts from one IP address since `since`.
   *
   * The second rate limit, and the one that catches the attack that matters:
   * per-address lockout does nothing against somebody trying one common
   * password across ten thousand addresses.
   */
  async countAttemptsFromIp(ipAddress: string, since: Date): Promise<number> {
    const row = await this.db
      .selectFrom('login_attempts')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ip_address', '=', ipAddress)
      .where('occurred_at', '>=', since)
      .executeTakeFirstOrThrow();

    return Number.parseInt(row.count, 10);
  }

  async findLock(email: string): Promise<AccountLock | undefined> {
    const row = await this.db
      .selectFrom('account_locks')
      .selectAll()
      .where('email', '=', normalise(email))
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Records a failure and locks the address if it has now had too many.
   *
   * Counting is stateful rather than a query over `login_attempts`, so that the
   * decision to lock and the count it is based on are one atomic write. A count
   * read separately can be raced by parallel attempts, which is exactly what an
   * attacker sends.
   *
   * A failure arriving after the window has elapsed restarts the count rather
   * than adding to it — otherwise five typos spread over a year would lock
   * somebody out.
   */
  async registerFailure(
    email: string,
    policy: LockPolicy,
    now: Date = new Date(),
  ): Promise<AccountLock> {
    const address = normalise(email);
    const windowStart = new Date(now.getTime() - policy.windowMs);
    const existing = await this.findLock(address);

    const continuing =
      existing !== undefined &&
      existing.lastFailureAt !== null &&
      existing.lastFailureAt >= windowStart;

    const failedCount = (continuing ? existing.failedCount : 0) + 1;
    const shouldLock = failedCount >= policy.threshold;
    const lockedUntil = shouldLock ? new Date(now.getTime() + policy.lockDurationMs) : null;

    const row = await this.db
      .insertInto('account_locks')
      .values({
        email: address,
        failed_count: failedCount,
        last_failure_at: now,
        locked_at: shouldLock ? now : null,
        locked_until: lockedUntil,
        unlocked_at: null,
        unlocked_by: null,
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet({
          failed_count: failedCount,
          last_failure_at: now,
          locked_at: shouldLock ? now : null,
          locked_until: lockedUntil,
          unlocked_at: null,
          unlocked_by: null,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  /** Clears the counter after a successful sign-in. */
  async clearFailures(email: string, now: Date = new Date()): Promise<void> {
    await this.db
      .insertInto('account_locks')
      .values({
        email: normalise(email),
        failed_count: 0,
        last_failure_at: null,
        locked_at: null,
        locked_until: null,
        unlocked_at: now,
        unlocked_by: 'auto',
      })
      .onConflict((oc) =>
        oc.column('email').doUpdateSet({
          failed_count: 0,
          locked_at: null,
          locked_until: null,
          unlocked_at: now,
          unlocked_by: 'auto',
        }),
      )
      .execute();
  }

  /**
   * Lifts a lock early, on the authority of a named person.
   *
   * `unlockedBy` is free text of the form `admin:<uuid>` or `platform:<uuid>`
   * rather than a foreign key, because an unlock can come from either identity
   * space and this table belongs to neither.
   */
  async unlock(email: string, unlockedBy: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable('account_locks')
      .set({
        failed_count: 0,
        locked_at: null,
        locked_until: null,
        unlocked_at: now,
        unlocked_by: unlockedBy,
      })
      .where('email', '=', normalise(email))
      .where('locked_at', 'is not', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

/** True when a lock is currently in force. */
export function isLocked(lock: AccountLock | undefined, now: Date = new Date()): boolean {
  return lock?.lockedUntil !== undefined && lock.lockedUntil !== null && lock.lockedUntil > now;
}

function normalise(email: string): string {
  return email.trim().toLowerCase();
}

function toDomain(row: Selectable<AccountLocksTable>): AccountLock {
  return {
    email: row.email,
    failedCount: row.failed_count,
    lastFailureAt: row.last_failure_at,
    lockedAt: row.locked_at,
    lockedUntil: row.locked_until,
    unlockedAt: row.unlocked_at,
    unlockedBy: row.unlocked_by,
    updatedAt: row.updated_at,
  };
}
