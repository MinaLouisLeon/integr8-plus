import { type PlatformUserId, toPlatformUserId } from '@integr8/core';
import type { Kysely, Selectable } from 'kysely';
import type { Database, PlatformUsersTable } from '../schema.js';

export interface PlatformUser {
  id: PlatformUserId;
  email: string;
  displayName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePlatformUserInput {
  id?: PlatformUserId | string;
  email: string;
  displayName: string;
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
}

function toDomain(row: Selectable<PlatformUsersTable>): PlatformUser {
  return {
    id: toPlatformUserId(row.id),
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
