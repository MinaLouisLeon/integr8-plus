import { FakeIdentityProvider, generateSigningKeyPair, totpCode } from '@integr8/auth';
import type { Role } from '@integr8/core';
import { closeDatabase, getPlatformDataSource, withTenant } from '@integr8/db';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices, type Services } from '../composition.js';
import { type ApiConfig, loadApiConfig } from '../config.js';
import { provisionTenantStorage } from '../media/tenant-storage.js';
import { createLogger } from '../http/logger.js';
import { allRoutes } from '../routes/index.js';
import { buildServer } from '../server.js';

/**
 * A real server over the disposable test database, for integration suites.
 *
 * The same assembly `index.ts` performs, with two substitutions: the identity
 * provider is faked, because everything worth testing happens after a
 * credential is accepted; and signing keys are generated per run, because a
 * test key in the repository is a key somebody eventually reuses in staging.
 */

const ACKNOWLEDGEMENT = 'i-know-this-database-is-disposable';
const PASSWORD = 'a perfectly good passphrase';
const PLATFORM_PASSWORD = 'a different perfectly good passphrase';

export interface Member {
  userId: string;
  email: string;
  password: string;
  role: Role;
}

/** A super admin, set up and signed in to the dashboard (P15). */
export interface PlatformAdmin {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface ApiHarness {
  app: FastifyInstance;
  config: ApiConfig;
  services: Services;
  /** The address this harness's requests come from. */
  remoteAddress: string;
  tenantId: string;
  member(role: Role, label: string): Promise<Member>;
  /** A signed-in super admin, for the platform routes (P15). */
  platformAdmin(label?: string): Promise<PlatformAdmin>;
  /**
   * A token for Integr8 staff acting as `who`, through an audited impersonation
   * grant. This is the only way to hold a staff-only permission such as
   * `form.manage` or `job_type.manage`, so a suite that needs a form or a job
   * type to exist builds it with this rather than with a member's own token.
   * One super admin is created per harness and reused.
   */
  staff(who: Pick<Member, 'userId'>, tenantId?: string): Promise<string>;
  signIn(member: Member): Promise<string>;
  /** `app.inject` with a bearer token and the client headers every request needs. */
  call(token: string, options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function startApi(
  options: { mediaStorage?: 'local' | 'r2'; env?: Record<string, string> } = {},
): Promise<ApiHarness> {
  if (process.env.APP_ENV !== 'test' || process.env.INTEGR8_TEST_DATABASE !== ACKNOWLEDGEMENT) {
    throw new Error(
      `API integration suites need APP_ENV=test, INTEGR8_TEST_DATABASE=${ACKNOWLEDGEMENT} and the test DATABASE_URL variables.`,
    );
  }

  const pair = await generateSigningKeyPair();
  process.env.AUTH_SIGNING_KEY_ID = pair.kid;
  process.env.AUTH_SIGNING_KEY = JSON.stringify(pair.privateJwk);
  process.env.AUTH_VERIFICATION_KEYS = JSON.stringify([pair.publicJwk]);
  process.env.AUTH_ISSUER = 'https://api.test.integr8';
  process.env.PLATFORM_SECRET_KEY ??= Buffer.alloc(32).toString('base64');

  const config = loadApiConfig({
    ...process.env,
    // Each run uploads into its own directory, so nothing is left for the next one to trip over.
    MEDIA_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'integr8-media-')),
    // Local unless a suite asks for R2 by name: credentials in .env must not
    // turn every suite into one that creates Cloudflare buckets.
    MEDIA_STORAGE: options.mediaStorage ?? 'local',
    API_MIN_SUPPORTED_CLIENT: '1.0.0',
    API_UPDATE_URL: 'https://integr8.example/download',
    ...options.env,
  });

  const identity = new FakeIdentityProvider();
  const services = await buildServices({ config, identity });
  const app = buildServer({
    config,
    services,
    routes: allRoutes(config),
    logger: createLogger({
      level: 'error',
      // Silent, unless a run sets DEBUG_API=1 to see why a request answered 500.
      write: (line: string) => {
        if (process.env.DEBUG_API === '1') {
          process.stdout.write(`${line}\n`);
        }
      },
    }),
  });
  await app.ready();

  const tenant = await getPlatformDataSource().tenants.create({
    slug: `api-${randomUUID().slice(0, 8)}`,
    name: 'API Test Ltd',
  });
  await provisionTenantStorage(services.media, tenant.id);

  // Each harness calls from its own address. The rate limiter keeps its windows
  // in the database, so suites sharing 127.0.0.1 within a minute would spend one
  // allowance between them.
  const remoteAddress = `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;

  const member = async (role: Role, label: string): Promise<Member> => {
    const email = `${label}.${randomUUID().slice(0, 8)}@test.integr8.example`;
    const created = await identity.createIdentity(email, PASSWORD);
    await withTenant(tenant.id, (tx) =>
      tx.tenantUsers.create({
        userId: created.userId,
        email,
        displayName: label,
        role,
        status: 'active',
      }),
    );
    return { userId: created.userId, email, password: PASSWORD, role };
  };

  const signIn = async (who: Member): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      remoteAddress,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'desktop' },
      payload: { email: who.email, password: who.password, clientApp: 'desktop' },
    });
    if (response.statusCode !== 200) {
      throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
    }
    return (JSON.parse(response.body) as { tokens: { accessToken: string } }).tokens.accessToken;
  };

  /**
   * Creates a super admin with a password and a second factor, and signs them
   * in. Going through the real sign-in rather than minting a token keeps the
   * suites honest about the flow the dashboard actually uses.
   */
  const platformAdmin = async (label = 'admin'): Promise<PlatformAdmin> => {
    const email = `${label}.${randomUUID().slice(0, 8)}@platform.integr8.example`;
    const account = await getPlatformDataSource().platformUsers.create({
      email,
      displayName: 'Test Super Admin',
    });

    await services.platform.setPassword(account.id, PLATFORM_PASSWORD);
    const enrolment = await services.platform.beginTotpEnrolment(account.id);
    await services.platform.confirmTotpEnrolment(account.id, totpCode(enrolment.secret));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/platform/auth/sign-in',
      remoteAddress,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
      payload: {
        email,
        password: PLATFORM_PASSWORD,
        code: totpCode(enrolment.secret),
      },
    });
    if (response.statusCode !== 200) {
      throw new Error(`platform sign-in failed: ${response.statusCode} ${response.body}`);
    }

    const body = JSON.parse(response.body) as {
      tokens: { accessToken: string; refreshToken: string; sessionId: string };
    };
    return {
      id: account.id,
      email,
      accessToken: body.tokens.accessToken,
      refreshToken: body.tokens.refreshToken,
      sessionId: body.tokens.sessionId,
    };
  };

  let staffAdmin: PlatformAdmin | undefined;
  const staff = async (who: Pick<Member, 'userId'>, tenantId = tenant.id): Promise<string> => {
    staffAdmin ??= await platformAdmin('staff');
    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform/companies/${tenantId}/impersonate`,
      remoteAddress,
      headers: {
        authorization: `Bearer ${staffAdmin.accessToken}`,
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
      },
      payload: { targetUserId: who.userId, reason: 'Integration test: setting the company up' },
    });
    if (response.statusCode !== 201) {
      throw new Error(`impersonation failed: ${response.statusCode} ${response.body}`);
    }
    return (JSON.parse(response.body) as { tokens: { accessToken: string } }).tokens.accessToken;
  };

  const call = (token: string, options: InjectOptions) =>
    app.inject({
      remoteAddress,
      ...options,
      headers: {
        authorization: `Bearer ${token}`,
        'x-client-version': '1.0.0',
        'x-client-app': 'desktop',
        ...(options.headers ?? {}),
      },
    });

  return {
    app,
    config,
    services,
    remoteAddress,
    tenantId: tenant.id,
    member,
    signIn,
    platformAdmin,
    staff,
    call,
    close: async () => {
      await app.close();
      await closeDatabase();
    },
  };
}
