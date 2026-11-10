import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Connection, NotSignedInError, type StaffTokens } from './connection.js';
import { seedTestCompany, startLocalApi } from './local.js';
import { RouteIndex } from './openapi.js';
import { normaliseApi, repoVersion } from './paths.js';
import { ask, askHidden } from './prompt.js';
import { type DevContext, createDevServer } from './server.js';
import { SessionStore, type StoredSession } from './store.js';
import { Trace } from './trace.js';

/**
 * The developer MCP server (P38), run from this repository:
 *
 *   pnpm dev-mcp login --api https://api.example.com [--production] [--file-store]
 *   pnpm dev-mcp logout [--api …]
 *   pnpm dev-mcp status
 *   pnpm dev-mcp serve [--api …]      what an AI tool runs (stdio)
 *   pnpm dev-mcp serve --local        the API booted on this laptop
 *
 * Only `login` takes a password and an authenticator code, typed in the
 * terminal with echo off; the MCP server reads the stored session and has no
 * tool that signs in.
 */

const HELP = `Integr8 developer MCP server

  pnpm dev-mcp login --api <https://api…> [--production] [--file-store]
        Sign in with a staff account (email, password, authenticator code).
        The session reaches test companies only and lasts 8 hours.
        --production   needed when the API is production
        --file-store   keep the session in a file only you can read, for a
                       machine without a keychain
  pnpm dev-mcp logout [--api <address>]   sign out and forget the session
  pnpm dev-mcp status                     which APIs, which account, time left
  pnpm dev-mcp serve [--api <address>]    the MCP server (AI tools start this)
  pnpm dev-mcp serve --local              against this laptop's API and database
                                          (APP_ENV development or test only)
`;

const SIGNED_OUT =
  'Not signed in. Ask the person to sign in in a terminal: pnpm dev-mcp login --api <the API address>';

interface Me {
  email: string;
  scope: string;
  sessionExpiresAt: string;
  environment: StoredSession['environment'];
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

async function login(values: { api?: string; production?: boolean; 'file-store'?: boolean }) {
  if (values.api === undefined) {
    return fail('Which API? pnpm dev-mcp login --api https://api.example.com');
  }
  const api = normaliseApi(values.api);
  const store = new SessionStore();
  let kind: 'keychain' | 'file';
  try {
    kind = await store.boxFor(values['file-store'] === true);
  } catch {
    return fail(
      'This machine has no keychain the tool can use. Run again with --file-store to keep the session in a file only you can read.',
    );
  }
  process.stderr.write(
    `Signing in to ${api} with a session limited to test companies (8 hours).\n`,
  );
  const email = await ask('Staff email: ');
  const password = await askHidden('Password: ');
  const code = await askHidden('Authenticator code: ');

  const trace = new Trace({ write: false });
  const plain = new Connection({
    api,
    tokens: {
      accessToken: '',
      refreshToken: '',
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    trace,
    clientVersion: repoVersion(),
  });
  const signedIn = await plain.request({
    as: 'staff',
    method: 'POST',
    path: '/v1/platform/auth/sign-in',
    body: { email, password, code, scope: 'test_companies' },
  });
  if (signedIn.status !== 200) {
    return fail(
      signedIn.status === 423
        ? 'The account is locked after too many failed attempts. Wait and try again.'
        : 'Not signed in: the email, password or code was not accepted.',
    );
  }
  const tokens = (signedIn.body as { tokens: StaffTokens }).tokens;
  const meAnswer = await plain.request({
    as: 'staff',
    method: 'GET',
    path: '/v1/platform/me',
    token: tokens.accessToken,
  });
  const me = meAnswer.body as Me;
  if (me.environment === 'production' && values.production !== true) {
    await plain.request({
      as: 'staff',
      method: 'POST',
      path: '/v1/platform/auth/sign-out',
      body: {},
      token: tokens.accessToken,
    });
    return fail(
      `${api} is PRODUCTION. Signed out again. If you mean it, run again with --production.`,
    );
  }
  await store.save(
    {
      api,
      email: me.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionExpiresAt: tokens.sessionExpiresAt,
      environment: me.environment,
    },
    kind,
  );
  if (me.environment === 'production') {
    process.stderr.write(
      [
        '',
        'PRODUCTION. With this session an AI tool in this repository can, for the next 8 hours:',
        '  - list and read the test companies on this API (no other company);',
        '  - act as any of their people, and as the company, doing anything they can do;',
        '  - read those companies’ audit lines and the mail they would have sent.',
        'It cannot reach a real company or any other staff screen; the API refuses. Every action',
        `is audited under ${me.email}. Start with read-only calls, with the audit log open.`,
        '',
      ].join('\n'),
    );
  }
  process.stderr.write(
    `Signed in as ${me.email} (${me.environment}) until ${new Date(tokens.sessionExpiresAt).toLocaleString()}. Kept in ${kind === 'keychain' ? 'the keychain' : `a file in ${store.folder} that only you can read`}.\n`,
  );
  return 0;
}

function chooseApi(store: SessionStore, wanted: string | undefined): string | undefined {
  if (wanted !== undefined) {
    return normaliseApi(wanted);
  }
  const fromEnv = process.env.INTEGR8_DEV_MCP_API;
  if (fromEnv !== undefined && fromEnv !== '') {
    return normaliseApi(fromEnv);
  }
  const live = store.list().filter((record) => new Date(record.sessionExpiresAt) > new Date());
  return live.length === 1 ? live[0]?.api : undefined;
}

async function logout(values: { api?: string }) {
  const store = new SessionStore();
  const api = chooseApi(store, values.api);
  if (api === undefined) {
    return fail('Which API? pnpm dev-mcp logout --api <address> (see pnpm dev-mcp status)');
  }
  const session = await store.load(api);
  if (session !== undefined) {
    const connection = new Connection({
      api,
      tokens: session,
      trace: new Trace({ write: false }),
      clientVersion: repoVersion(),
    });
    await connection
      .staff({ method: 'POST', path: '/v1/platform/auth/sign-out', body: {} })
      .catch(() => undefined);
  }
  await store.remove(api);
  process.stderr.write(`Signed out of ${api} and forgot the session.\n`);
  return 0;
}

function status() {
  const records = new SessionStore().list();
  if (records.length === 0) {
    process.stdout.write('No staff session. pnpm dev-mcp login --api <address>\n');
    return 0;
  }
  for (const record of records) {
    const minutes = Math.round((new Date(record.sessionExpiresAt).getTime() - Date.now()) / 60_000);
    process.stdout.write(
      `${record.api}  ${record.email}  ${record.environment}  ${minutes > 0 ? `${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min left` : 'ended: sign in again'}  (${record.store})\n`,
    );
  }
  return 0;
}

async function serve(values: { api?: string; local?: boolean }) {
  const trace = new Trace();
  const routes = RouteIndex.load();
  let context: Promise<DevContext> | undefined;
  let stop: (() => void) | undefined;

  const connect = async (): Promise<DevContext> => {
    if (values.local === true) {
      const local = await startLocalApi();
      stop = local.stop;
      return {
        mode: 'local',
        connection: new Connection({
          api: local.url,
          tokens: local.tokens,
          trace,
          clientVersion: repoVersion(),
        }),
        createCompany: (input) => seedTestCompany(input),
      };
    }
    const store = new SessionStore();
    const api = chooseApi(store, values.api);
    const session = api === undefined ? undefined : await store.load(api);
    if (api === undefined || session === undefined) {
      throw new NotSignedInError(SIGNED_OUT);
    }
    const record = store.list().find((candidate) => candidate.api === api);
    return {
      mode: 'remote',
      connection: new Connection({
        api,
        tokens: session,
        trace,
        clientVersion: repoVersion(),
        persist: async (tokens) => {
          await store.save({ ...session, ...tokens }, record?.store ?? 'keychain');
        },
      }),
    };
  };

  const server = createDevServer({
    routes,
    trace,
    context: () => {
      context ??= connect().catch((error: unknown) => {
        context = undefined;
        throw error;
      });
      return context;
    },
  });
  const finish = async () => {
    if (context !== undefined) {
      await (await context.catch(() => undefined))?.connection.endGrants();
    }
    stop?.();
  };
  server.server.onclose = () => {
    void finish();
  };
  process.once('SIGTERM', () => {
    void finish().finally(() => process.exit(0));
  });
  await server.connect(new StdioServerTransport());
  return -1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      api: { type: 'string' },
      production: { type: 'boolean' },
      'file-store': { type: 'boolean' },
      local: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  switch (command) {
    case 'login':
      return login(values);
    case 'logout':
      return logout(values);
    case 'status':
      return status();
    case 'serve':
      return serve(values);
    default:
      process.stdout.write(HELP);
      return command === undefined || command === 'help' || command === '--help' ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) {
      process.exitCode = code;
    }
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
