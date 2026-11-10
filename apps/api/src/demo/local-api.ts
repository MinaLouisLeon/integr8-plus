import { randomBytes } from 'node:crypto';
import { totpCode } from '@integr8/auth';
import { closeDatabase, getPlatformDataSource } from '@integr8/db';
import { buildServices } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { createLogger } from '../http/logger.js';
import { allRoutes } from '../routes/index.js';
import { buildServer } from '../server.js';

/**
 * The developer MCP server's local mode (P38): this API, booted in this
 * process against the developer's own database, listening on 127.0.0.1 only,
 * with a staff session limited to test companies made for the tool.
 *
 *   pnpm --filter @integr8/api --silent dev-mcp-local
 *
 * Prints one line of JSON, `{ url, accessToken, refreshToken, sessionExpiresAt }`,
 * then serves until its standard input closes (the tool exits) or it is
 * stopped. The tool talks to it over HTTP exactly as it talks to a remote API,
 * so local and remote mode run the same code. Refused unless APP_ENV is
 * development or test: a slip of a connection string must not point this at a
 * real database.
 *
 * The staff account is `dev-mcp@integr8.invalid`, made on first use. Its
 * password and second factor are replaced each start and never printed; the
 * session it signs in with is limited like any other, so everything the tool
 * does is confined to test companies and audited under that account.
 */

const ACCOUNT = 'dev-mcp@integr8.invalid';

async function main(): Promise<number> {
  const config = loadApiConfig({
    ...process.env,
    // Every request the tool makes comes from this one address.
    API_TENANT_RATE_LIMIT: '1000000',
    API_IP_RATE_LIMIT: '1000000',
  });
  if (config.APP_ENV !== 'development' && config.APP_ENV !== 'test') {
    process.stderr.write(
      `Local mode runs only with APP_ENV=development or test; this is ${config.APP_ENV}. Use remote mode (pnpm dev-mcp login) for any other API.\n`,
    );
    return 1;
  }

  const services = await buildServices({ config });
  const app = buildServer({
    config,
    services,
    routes: allRoutes(config),
    logger: createLogger({
      level: 'error',
      service: 'integr8-dev-mcp-local',
      release: config.API_RELEASE,
    }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const platform = getPlatformDataSource();
  const account =
    (await platform.platformUsers.list()).find((user) => user.email === ACCOUNT) ??
    (await platform.platformUsers.create({
      email: ACCOUNT,
      displayName: 'Developer MCP (local)',
      canManageStaff: false,
    }));
  const password = `Dev-${randomBytes(18).toString('base64url')}`;
  await services.platform.setPassword(account.id, password);
  const enrolment = await services.platform.beginTotpEnrolment(account.id);
  await services.platform.confirmTotpEnrolment(account.id, totpCode(enrolment.secret));

  const signedIn = await app.inject({
    method: 'POST',
    url: '/v1/platform/auth/sign-in',
    remoteAddress: '127.0.0.1',
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'api' },
    payload: {
      email: ACCOUNT,
      password,
      code: totpCode(enrolment.secret),
      scope: 'test_companies',
    },
  });
  if (signedIn.statusCode !== 200) {
    process.stderr.write(
      `The local staff sign-in failed: ${signedIn.statusCode} ${signedIn.body}\n`,
    );
    await app.close();
    return 1;
  }
  const { tokens } = JSON.parse(signedIn.body) as {
    tokens: { accessToken: string; refreshToken: string; sessionExpiresAt: string };
  };
  process.stdout.write(
    `${JSON.stringify({
      url: `http://127.0.0.1:${String(port)}`,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionExpiresAt: tokens.sessionExpiresAt,
    })}\n`,
  );

  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
    process.stdin.resume();
  });
  await app.close();
  return 0;
}

main()
  .then(async (code) => {
    await closeDatabase().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
