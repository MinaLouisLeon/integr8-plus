import {
  type PlatformUserId,
  type Role,
  type TenantId,
  type UserId,
  toPlatformUserId,
  toUserId,
} from '@integr8/core';
import {
  assertSchemaUpToDate,
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  loadDatabaseConfig,
  type Tenant,
  withTenant,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { loadAuthConfig } from '../config.js';
import { loadSigningKey, loadVerificationKeys } from '../keys.js';
import { FakeIdentityProvider, type FakeIdentity } from '../identity-provider.js';
import { ImpersonationService } from '../services/impersonation-service.js';
import { PlatformSessionService } from '../services/platform-session-service.js';
import { InvitationService } from '../services/invitation-service.js';
import { SessionService } from '../services/session-service.js';
import { SignInService } from '../services/sign-in-service.js';
import { TokenService } from '../tokens.js';

/**
 * Wiring for the auth integration suites.
 *
 * Unlike `@integr8/db`'s harness this one never truncates. Every fixture gets a
 * fresh company with a unique slug and a fresh set of email addresses, so the
 * suites can run against a shared scratch database without fighting each other
 * — and, more to the point, without a helper in this package that is capable of
 * emptying a database.
 *
 * Lockout and rate limiting are keyed on the email address across the whole
 * platform, which is exactly why {@link uniqueEmail} exists: two suites using
 * `dana@example.com` would lock each other out.
 */

const ACKNOWLEDGEMENT = 'i-know-this-database-is-disposable';

export class TestDatabaseUnavailableError extends Error {
  constructor(reason: string) {
    super(
      [
        `Cannot run the auth integration suite: ${reason}`,
        '',
        'It needs the same disposable Postgres as @integr8/db, with migrations applied:',
        '',
        '  APP_ENV=test',
        `  INTEGR8_TEST_DATABASE=${ACKNOWLEDGEMENT}`,
        '  DATABASE_URL, DATABASE_URL_ADMIN, DATABASE_URL_AUTH',
        '  AUTH_SIGNING_KEY, AUTH_SIGNING_KEY_ID, AUTH_VERIFICATION_KEYS',
        '  PLATFORM_SECRET_KEY',
        '',
        'See docs/database/runbook-supabase-setup.md and docs/auth/README.md.',
      ].join('\n'),
    );
    this.name = 'TestDatabaseUnavailableError';
  }
}

export function requireTestEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.APP_ENV !== 'test') {
    throw new TestDatabaseUnavailableError(`APP_ENV is "${env.APP_ENV ?? '(unset)'}", not "test"`);
  }
  if (env.INTEGR8_TEST_DATABASE !== ACKNOWLEDGEMENT) {
    throw new TestDatabaseUnavailableError(
      'INTEGR8_TEST_DATABASE is not set to the acknowledgement',
    );
  }
}

export interface TestServices {
  tokens: TokenService;
  sessions: SessionService;
  signIn: SignInService;
  invitations: InvitationService;
  impersonation: ImpersonationService;
  platform: PlatformSessionService;
  identity: FakeIdentityProvider;
  setNow: (date: Date) => void;
}

/**
 * Builds the service graph against the test database.
 *
 * The identity provider is faked: everything worth testing here happens after
 * a credential is accepted, and a real Supabase project in front of it would
 * make the suite slower and flakier without making it more truthful.
 */
export async function buildServices(identities: FakeIdentity[] = []): Promise<TestServices> {
  requireTestEnvironment();
  configureDatabase(loadDatabaseConfig());
  await assertSchemaUpToDate();

  const config = loadAuthConfig();
  let now = new Date();
  const clock = () => now;

  const tokens = new TokenService({
    config,
    signingKey: await loadSigningKey(config),
    verificationKeys: await loadVerificationKeys(config),
    now: clock,
  });

  const identity = new FakeIdentityProvider(identities);
  const sessions = new SessionService({ tokens, config, now: clock });

  return {
    tokens,
    sessions,
    identity,
    signIn: new SignInService({ identity, sessions, config, now: clock }),
    invitations: new InvitationService({ identity, sessions, config, now: clock }),
    impersonation: new ImpersonationService({ sessions, config, now: clock }),
    platform: new PlatformSessionService({ tokens, config, now: clock }),
    setNow: (date: Date) => {
      now = date;
    },
  };
}

export async function releaseServices(): Promise<void> {
  await closeDatabase();
}

let counter = 0;

function unique(): string {
  counter += 1;
  return `${String(Date.now() % 1_000_000)}${String(counter)}`;
}

/** An address no other suite or run will use, so lockout stays isolated. */
export function uniqueEmail(label: string): string {
  return `${label}.${unique()}@test.integr8.example`;
}

export interface TenantFixture {
  tenant: Tenant;
  id: TenantId;
}

export async function createTenant(prefix: string): Promise<TenantFixture> {
  const tenant = await getPlatformDataSource().tenants.create({
    slug: `${prefix}-${unique()}`,
    name: `${prefix} Facilities Ltd`,
  });

  return { tenant, id: tenant.id };
}

export interface MemberFixture {
  userId: UserId;
  email: string;
  password: string;
  role: Role;
}

/** Creates a membership and the matching credential in the fake provider. */
export async function createMember(
  identity: FakeIdentityProvider,
  tenantId: TenantId,
  role: Role,
  label = 'member',
): Promise<MemberFixture> {
  const email = uniqueEmail(label);
  const password = 'a perfectly good passphrase';
  const created = await identity.createIdentity(email, password);

  await withTenant(tenantId, (tx) =>
    tx.tenantUsers.create({
      userId: created.userId,
      email,
      displayName: label,
      role,
      status: 'active',
    }),
  );

  return { userId: created.userId, email, password, role };
}

/** A platform (super admin) identity, for the impersonation suite. */
export async function createPlatformUser(
  label = 'super',
): Promise<{ id: PlatformUserId; email: string }> {
  const email = uniqueEmail(label);
  const created = await getPlatformDataSource().platformUsers.create({
    id: randomUUID(),
    email,
    displayName: 'Platform Super Admin',
  });

  return { id: created.id, email };
}

export { toPlatformUserId, toUserId, withTenant };
