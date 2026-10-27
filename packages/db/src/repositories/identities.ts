import type { Kysely, Selectable } from 'kysely';
import type { Database, IdentitiesTable } from '../schema.js';

/**
 * Credentials for people who sign in to companies, kept in this database
 * (0054). Used when the API runs with `IDENTITY_PROVIDER=local` instead of
 * Supabase.
 *
 * Reached only through the pre-authentication role: sign-in has to look an
 * address up before any company is known. Addresses are stored lower-cased and
 * trimmed, and the check constraint holds every writer to that, so a lookup is
 * an equality and two spellings of one address cannot become two people.
 */

export interface Identity {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateIdentityInput {
  /** Reuse an existing user id (one Supabase gave, say); a new one otherwise. */
  id?: string;
  email: string;
  passwordHash: string | null;
  emailVerified: boolean;
}

export function identityEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class IdentitiesRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async findByEmail(email: string): Promise<Identity | undefined> {
    const row = await this.db
      .selectFrom('identities')
      .selectAll()
      .where('email', '=', identityEmail(email))
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  }

  async findById(id: string): Promise<Identity | undefined> {
    const row = await this.db
      .selectFrom('identities')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  }

  /** Undefined when the address already has an identity: the caller looks first. */
  async create(input: CreateIdentityInput): Promise<Identity | undefined> {
    const row = await this.db
      .insertInto('identities')
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        email: identityEmail(input.email),
        password_hash: input.passwordHash,
        email_verified_at: input.emailVerified ? new Date() : null,
      })
      .onConflict((conflict) => conflict.column('email').doNothing())
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toIdentity(row);
  }

  async setPassword(id: string, passwordHash: string): Promise<boolean> {
    const result = await this.db
      .updateTable('identities')
      .set({ password_hash: passwordHash, updated_at: new Date() })
      .where('id', '=', id)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async markVerified(id: string): Promise<void> {
    await this.db
      .updateTable('identities')
      .set({ email_verified_at: new Date(), updated_at: new Date() })
      .where('id', '=', id)
      .where('email_verified_at', 'is', null)
      .execute();
  }

  /** Stores a link by its hash. The token itself is only ever in the email. */
  async createMagicLink(input: {
    identityId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<void> {
    await this.db
      .insertInto('identity_magic_links')
      .values({
        token_hash: input.tokenHash,
        identity_id: input.identityId,
        expires_at: input.expiresAt,
      })
      .execute();
  }

  /**
   * Spends a link, once. Returns its identity, or undefined when the link is
   * unknown, spent, expired or belongs to another address. A single update, so
   * two requests racing with the same link cannot both win.
   */
  async consumeMagicLink(
    tokenHash: string,
    email: string,
    now: Date = new Date(),
  ): Promise<Identity | undefined> {
    const spent = await this.db
      .updateTable('identity_magic_links')
      .set({ used_at: now })
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .where('expires_at', '>', now)
      .where('identity_id', 'in', (eb) =>
        eb.selectFrom('identities').select('id').where('email', '=', identityEmail(email)),
      )
      .returning('identity_id')
      .executeTakeFirst();
    if (spent === undefined) {
      return undefined;
    }
    return this.findById(spent.identity_id);
  }

  /** Removes spent and expired links. Returns how many went. */
  async sweepMagicLinks(now: Date = new Date()): Promise<number> {
    const result = await this.db
      .deleteFrom('identity_magic_links')
      .where((eb) => eb.or([eb('used_at', 'is not', null), eb('expires_at', '<=', now)]))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

function toIdentity(row: Selectable<IdentitiesTable>): Identity {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
