import { FakeIdentityProvider, generateSigningKeyPair } from '@integr8/auth';
import type { Role } from '@integr8/core';
import { closeDatabase, getPlatformDataSource, withTenant } from '@integr8/db';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServices } from '../composition.js';
import { loadApiConfig } from '../config.js';
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

export interface Member {
  userId: string;
  email: string;
  password: string;
  role: Role;
}

export interface ApiHarness {
  app: FastifyInstance;
  tenantId: string;
  member(role: Role, label: string): Promise<Member>;
  signIn(member: Member): Promise<string>;
  /** `app.inject` with a bearer token and the client headers every request needs. */
  call(token: string, options: InjectOptions): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export async function startApi(): Promise<ApiHarness> {
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

  const config = loadApiConfig({
    ...process.env,
    // Each run uploads into its own directory, so nothing is left for the next one to trip over.
    MEDIA_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'integr8-media-')),
    API_MIN_SUPPORTED_CLIENT: '1.0.0',
    API_UPDATE_URL: 'https://integr8.example/download',
  });

  const identity = new FakeIdentityProvider();
  const services = await buildServices({ config, identity });
  const app = buildServer({
    config,
    services,
    routes: allRoutes(config),
    logger: createLogger({ level: 'error', write: () => undefined }),
  });
  await app.ready();

  const tenant = await getPlatformDataSource().tenants.create({
    slug: `api-${randomUUID().slice(0, 8)}`,
    name: 'API Test Ltd',
  });

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
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'desktop' },
      payload: { email: who.email, password: who.password, clientApp: 'desktop' },
    });
    if (response.statusCode !== 200) {
      throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
    }
    return (JSON.parse(response.body) as { tokens: { accessToken: string } }).tokens.accessToken;
  };

  const call = (token: string, options: InjectOptions) =>
    app.inject({
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
    tenantId: tenant.id,
    member,
    signIn,
    call,
    close: async () => {
      await app.close();
      await closeDatabase();
    },
  };
}
