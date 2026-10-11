import { type PlatformUserId, toPlatformUserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { Database, PlatformUsersTable } from '../schema.js';

export interface PlatformUser {
  id: PlatformUserId;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Set up means both a password and a second factor; neither alone lets anybody in (P15). */
  hasPassword: boolean;
  totpEnrolledAt: Date | null;
  lastSignedInAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
  /**
   * Made by the terminal command, so may add and remove other staff. Accounts
   * added from the dashboard never may (0023).
   */
  canManageStaff: boolean;
  /** The staff manager who added this account from the dashboard; null for terminal accounts. */
  addedBy: PlatformUserId | null;
}

/**
 * What sign-in needs and nothing else sees: the stored password hash and the
 * encrypted TOTP secret. Kept off {@link PlatformUser} so that a screen, a log
 * line or an API response cannot carry them by accident.
 */
export interface PlatformCredentials {
  id: PlatformUserId;
  email: string;
  displayName: string;
  isActive: boolean;
  passwordHash: string | null;
  totpSecret: string | null;
  totpEnrolledAt: Date | null;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface CreatePlatformUserInput {
  id?: PlatformUserId | string;
  email: string;
  displayName: string;
  /** Only the terminal command sets this. Defaults to false. */
  canManageStaff?: boolean;
  /** The staff manager adding this account from the dashboard. */
  addedBy?: PlatformUserId | string;
}

/**
 * Super-admin identities.
 *
 * Reachable only through the platform data source. The app role holds no grant
 * on `platform_users` at all, and `assertRlsEnforced()` treats being able to
 * read this table as proof that the runtime connection is over-privileged and
 * refuses to start.
 */
export class PlatformUsersRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreatePlatformUserInput): Promise<PlatformUser> {
    const row = await this.db
      .insertInto('platform_users')
      .values({
        ...(input.id === undefined ? {} : { id: toPlatformUserId(input.id) }),
        email: input.email.trim().toLowerCase(),
        display_name: input.displayName.trim(),
        ...(input.canManageStaff === undefined ? {} : { can_manage_staff: input.canManageStaff }),
        ...(input.addedBy === undefined
          ? {}
          : { added_by_platform_user_id: toPlatformUserId(input.addedBy) }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findByEmail(email: string): Promise<PlatformUser | undefined> {
    const row = await this.db
      .selectFrom('platform_users')
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async findById(id: PlatformUserId | string): Promise<PlatformUser | undefined> {
    const row = await this.db
      .selectFrom('platform_users')
      .selectAll()
      .where('id', '=', toPlatformUserId(id))
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /** The hash and the secret, for the one caller that verifies them. */
  async credentialsFor(email: string): Promise<PlatformCredentials | undefined> {
    const row = await this.db
      .selectFrom('platform_users')
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();

    return row === undefined ? undefined : toCredentials(row);
  }

  async credentialsById(id: PlatformUserId | string): Promise<PlatformCredentials | undefined> {
    const row = await this.db
      .selectFrom('platform_users')
      .selectAll()
      .where('id', '=', toPlatformUserId(id))
      .executeTakeFirst();

    return row === undefined ? undefined : toCredentials(row);
  }

  async setPassword(
    id: PlatformUserId | string,
    passwordHash: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({
        password_hash: passwordHash,
        password_changed_at: now,
        failed_attempts: 0,
        locked_until: null,
      })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }

  /** Enrols a second factor, or — with `null` — removes one so it can be set up again. */
  async setTotpSecret(
    id: PlatformUserId | string,
    secret: string | null,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({ totp_secret: secret, totp_enrolled_at: secret === null ? null : now })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }

  async recordSignIn(id: PlatformUserId | string, now = new Date()): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({ last_signed_in_at: now, failed_attempts: 0, locked_until: null })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }

  /**
   * One more wrong password or code. Past `lockAfter` the account is locked for
   * `lockFor`, and the count keeps rising so a burst does not reset it.
   */
  async recordFailure(
    id: PlatformUserId | string,
    options: { lockAfter: number; lockForMs: number; now?: Date },
  ): Promise<{ failedAttempts: number; lockedUntil: Date | null }> {
    const now = options.now ?? new Date();
    const lockedUntil = new Date(now.getTime() + options.lockForMs);
    const row = await this.db
      .updateTable('platform_users')
      .set((eb) => ({
        failed_attempts: eb('failed_attempts', '+', 1),
        // Cast both branches: a bare parameter inside `case` reaches Postgres
        // as text, and a text expression cannot be assigned to a timestamptz.
        locked_until: eb
          .case()
          .when(eb('failed_attempts', '+', 1), '>=', options.lockAfter)
          .then(sql<Date>`${lockedUntil}::timestamptz`)
          .else(sql<Date | null>`null::timestamptz`)
          .end(),
      }))
      .where('id', '=', toPlatformUserId(id))
      .returning(['failed_attempts', 'locked_until'])
      .executeTakeFirstOrThrow();

    return { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until };
  }

  async unlock(id: PlatformUserId | string): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({ failed_attempts: 0, locked_until: null })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }

  async list(): Promise<PlatformUser[]> {
    return (
      await this.db.selectFrom('platform_users').selectAll().orderBy('created_at', 'asc').execute()
    ).map(toDomain);
  }

  async setActive(id: PlatformUserId | string, isActive: boolean): Promise<boolean> {
    const result = await this.db
      .updateTable('platform_users')
      .set({ is_active: isActive })
      .where('id', '=', toPlatformUserId(id))
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Marks an account as one the terminal command made, so it may manage staff. */
  async setCanManageStaff(id: PlatformUserId | string, canManageStaff: boolean): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({ can_manage_staff: canManageStaff })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }

  /**
   * Ends every impersonation this account still has open, in any company.
   *
   * Removing somebody from the staff ends their dashboard sessions; this ends
   * the company sessions they opened from it, which would otherwise run on
   * until their grant expired. The owner connection reaches every company's
   * grants, which is why this lives here and not on the tenant-scoped side.
   */
  async endLiveImpersonations(id: PlatformUserId | string, now = new Date()): Promise<number> {
    const result = await this.db
      .updateTable('impersonation_grants')
      .set({ ended_at: now, ended_reason: 'ended_by_admin' })
      .where('platform_user_id', '=', toPlatformUserId(id))
      .where('ended_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n);
  }

  /** Brings a removed account back, recording who did it and clearing any lockout. */
  async reactivate(
    id: PlatformUserId | string,
    addedBy: PlatformUserId | string | null,
  ): Promise<void> {
    await this.db
      .updateTable('platform_users')
      .set({
        is_active: true,
        failed_attempts: 0,
        locked_until: null,
        ...(addedBy === null ? {} : { added_by_platform_user_id: toPlatformUserId(addedBy) }),
      })
      .where('id', '=', toPlatformUserId(id))
      .execute();
  }
}

function toDomain(row: Selectable<PlatformUsersTable>): PlatformUser {
  return {
    id: toPlatformUserId(row.id),
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasPassword: row.password_hash !== null,
    totpEnrolledAt: row.totp_enrolled_at,
    lastSignedInAt: row.last_signed_in_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    canManageStaff: row.can_manage_staff,
    addedBy:
      row.added_by_platform_user_id === null
        ? null
        : toPlatformUserId(row.added_by_platform_user_id),
  };
}

function toCredentials(row: Selectable<PlatformUsersTable>): PlatformCredentials {
  return {
    id: toPlatformUserId(row.id),
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active,
    passwordHash: row.password_hash,
    totpSecret: row.totp_secret,
    totpEnrolledAt: row.totp_enrolled_at,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
  };
}
