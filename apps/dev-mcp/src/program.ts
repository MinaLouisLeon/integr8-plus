import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, posix, win32 } from 'node:path';
import {
  compareVersions,
  EXPECTED_TOOLS as FORMS_TOOLS,
  type Host,
  localAppData,
  osName,
  parseChecksum,
  replaceProgram,
  type SetupProfile,
  type UpdateOffer,
} from '@integr8/forms-ai/setup';
import { Connection } from './connection.js';
import {
  INSTALLED,
  isRepository,
  readSettings,
  repoVersion,
  repositoryRoot,
  writeSettings,
} from './paths.js';
import { DRAFT_REQUEST_TOOLS } from './server.js';
import { KEYRING_FILE, SessionStore } from './store.js';
import { Trace } from './trace.js';

/**
 * The developer MCP server as an installed program (P43): what the installer
 * (Forms for AI's, driven by this profile) needs to know about it. It installs
 * beside its keychain module, connects itself to the AI tools as
 * `integr8-dev`, signs in from the menu, remembers the integr8-plus folder for
 * change requests, and updates itself from the release list the API gives a
 * signed-in staff session (the repository is private, so GitHub's public API
 * finds nothing).
 */

export const PROGRAM_NAME = 'integr8-dev-mcp';
export const SERVER_NAME = 'integr8-dev';
export const DEFAULT_API = 'https://api.integr8-media.com';

/** Where the program lives once installed: one fixed folder per user. */
export function devInstallDir(host: Host): string {
  const override = host.env.INTEGR8_DEV_MCP_INSTALL;
  if (override !== undefined && override !== '') {
    return override;
  }
  switch (host.platform) {
    case 'win32':
      return win32.join(localAppData(host), 'Integr8', 'dev-mcp');
    case 'darwin':
      return posix.join(host.home, 'Library', 'Application Support', 'Integr8', 'dev-mcp');
    default: {
      const data = host.env.XDG_DATA_HOME;
      const base = data?.startsWith('/') === true ? data : posix.join(host.home, '.local', 'share');
      return posix.join(base, 'integr8', 'dev-mcp');
    }
  }
}

export function devInstalledProgram(host: Host): string {
  const folder = devInstallDir(host);
  const file = host.platform === 'win32' ? `${PROGRAM_NAME}.exe` : PROGRAM_NAME;
  return host.platform === 'win32' ? win32.join(folder, file) : posix.join(folder, file);
}

/** The developer server's own tools, besides the Forms for AI tools it carries. */
export const DEV_TOOLS = [
  'status',
  'list_test_companies',
  'create_test_company',
  'use_company',
  'find_route',
  'get_route',
  'call_api',
  'get_trace',
  'get_audit',
  'read_outbox',
  'import_form_package',
  'submit_form',
  'list_change_requests',
  'get_change_request',
  'hand_over_change_request',
  // Company websites (P43).
  'create_website_key',
  'write_website_env',
  'list_website_keys',
  'revoke_website_key',
  'set_website_access',
  'call_website_api',
  'seed_shared_documents',
] as const;

/** Every tool the server lists: its own, and Forms for AI's with two renamed. */
export const ALL_TOOLS: readonly string[] = [
  ...DEV_TOOLS,
  ...FORMS_TOOLS.map((name) =>
    name === 'list_change_requests'
      ? DRAFT_REQUEST_TOOLS.list
      : name === 'get_change_request'
        ? DRAFT_REQUEST_TOOLS.get
        : name,
  ),
];

/** How to run this program again: the executable itself, or Node with this script. */
function self(): { command: string; args: string[] } {
  return INSTALLED
    ? { command: process.execPath, args: [] }
    : { command: process.execPath, args: [...process.execArgv, process.argv[1] ?? ''] };
}

interface DevMcpFile {
  name: string;
  url: string;
  platform: string;
  arch: string;
  kind: 'zip' | 'program' | 'keyring';
  checksumUrl: string | null;
}

interface DevMcpOffer extends UpdateOffer {
  program: DevMcpFile;
  keyring: DevMcpFile | undefined;
}

const offers = new Map<string, DevMcpOffer>();

/**
 * Asks a signed-in API which developer program its release list carries.
 * Quiet (undefined) when nobody is signed in, offline, or nothing newer.
 */
export async function checkForDevUpdate(
  host: Host,
  current: string,
  options: { store?: SessionStore; fetch?: typeof fetch } = {},
): Promise<DevMcpOffer | undefined> {
  if (host.env.INTEGR8_DEV_MCP_NO_UPDATE_CHECK === '1' || !/^\d+\.\d+\.\d+$/u.test(current)) {
    return undefined;
  }
  const os = osName(host.platform);
  if (os === undefined) {
    return undefined;
  }
  const store = options.store ?? new SessionStore();
  const record = store
    .list()
    .filter((candidate) => new Date(candidate.sessionExpiresAt).getTime() > Date.now())
    .sort((a, b) => b.sessionExpiresAt.localeCompare(a.sessionExpiresAt))[0];
  if (record === undefined) {
    return undefined;
  }
  try {
    const session = await store.load(record.api);
    if (session === undefined) {
      return undefined;
    }
    const connection = new Connection({
      api: record.api,
      tokens: session,
      trace: new Trace({ write: false }),
      clientVersion: repoVersion(),
      persist: (tokens) => store.save({ ...session, ...tokens }, record.store),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const answer = await connection.staff({ method: 'GET', path: '/v1/platform/downloads' });
    const devMcp = (
      answer.body as {
        devMcp?: { status: string; release?: { version: string; downloads: DevMcpFile[] } };
      } | null
    )?.devMcp;
    if (answer.status !== 200 || devMcp?.status !== 'found' || devMcp.release === undefined) {
      return undefined;
    }
    const { version, downloads } = devMcp.release;
    if (compareVersions(version, current) <= 0) {
      return undefined;
    }
    const mine = (kind: DevMcpFile['kind']) =>
      downloads.find(
        (file) => file.kind === kind && file.platform === os && file.arch === host.arch,
      );
    const program = mine('program');
    if (program?.checksumUrl == null) {
      return undefined;
    }
    const offer: DevMcpOffer = { version, name: program.name, program, keyring: mine('keyring') };
    offers.set(version, offer);
    return offer;
  } catch {
    return undefined;
  }
}

/** Downloads one file and checks it against its published SHA-256. */
async function verifiedDownload(file: DevMcpFile, get: typeof fetch): Promise<Uint8Array> {
  if (file.checksumUrl === null) {
    throw new Error(`${file.name} has no published checksum; nothing was changed.`);
  }
  const signal = AbortSignal.timeout(10 * 60 * 1000);
  const sums = await get(file.checksumUrl, { headers: { 'user-agent': PROGRAM_NAME }, signal });
  const expected = sums.ok ? parseChecksum(await sums.text()) : undefined;
  if (expected === undefined) {
    throw new Error(`The checksum of ${file.name} could not be read.`);
  }
  const response = await get(file.url, { headers: { 'user-agent': PROGRAM_NAME }, signal });
  if (!response.ok) {
    throw new Error(`The download of ${file.name} answered ${String(response.status)}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error(`${file.name} does not match its published checksum; nothing was changed.`);
  }
  return bytes;
}

/** Puts the new program (and keychain module) in place of the installed ones. */
export async function applyDevUpdate(
  offer: UpdateOffer,
  target: string,
  options: { fetch?: typeof fetch } = {},
): Promise<void> {
  const known = offers.get(offer.version);
  if (known === undefined) {
    throw new Error('That update is no longer known; check again.');
  }
  const get = options.fetch ?? fetch;
  // Both are downloaded and checked before either is replaced.
  const program = await verifiedDownload(known.program, get);
  const keyring =
    known.keyring === undefined ? undefined : await verifiedDownload(known.keyring, get);
  if (keyring !== undefined) {
    replaceProgram(join(dirname(target), KEYRING_FILE), keyring);
  }
  replaceProgram(target, program);
}

export const DEV_PROFILE: SetupProfile = {
  title: 'Integr8 developer MCP server',
  // The product's version: releases, their files and updates are named by it.
  version: repoVersion(),
  tagline:
    'Lets AI coding tools try features on a running Integr8 API in test companies, build company websites against them, and build forms.',
  serverName: SERVER_NAME,
  installedProgram: devInstalledProgram,
  installDir: devInstallDir,
  companions: [KEYRING_FILE],
  buildHint: 'pnpm --filter @integr8/dev-mcp sea',
  expectedTools: ALL_TOOLS,
  afterConnect: ({ say, paint }) => {
    say('Sign in once with your staff account (choose "Sign in to an Integr8 API" below), then');
    say('restart each AI tool you connected (or start a new chat) and ask it, for example:');
    say(
      paint.cyan(
        '  "Use integr8-dev: choose a test company, make a website key for it in C:\\sites\\acme\\.env.local and seed two shared documents."',
      ),
    );
  },
  outputFolder: false,
  checkForUpdate: (host, current) => checkForDevUpdate(host, current),
  applyUpdate: (offer, target) => applyDevUpdate(offer, target),
  extraMenu: [
    {
      label: 'Sign in to an Integr8 API',
      run: async ({ prompter, say, paint }) => {
        const api = await prompter.input('Which API?', DEFAULT_API);
        if (api === undefined || api.trim() === '') {
          return;
        }
        // The sign-in runs as its own process with the terminal to itself (the
        // menu lets go of it between questions), so the password and code are
        // typed with echo off, as from a terminal.
        const { command, args } = self();
        const result = spawnSync(command, [...args, 'login', '--api', api.trim()], {
          stdio: 'inherit',
          windowsHide: false,
        });
        say(
          result.status === 0
            ? paint.green('Signed in.')
            : paint.red('Not signed in. Try again, or run the login command in a terminal.'),
        );
      },
    },
    {
      label: 'Remember my integr8-plus folder (for change requests)',
      run: async ({ prompter, say, paint }) => {
        const current = readSettings().repository;
        const chosen = await prompter.input(
          'The absolute path of your integr8-plus checkout?',
          current ?? '',
        );
        if (chosen === undefined || chosen.trim() === '') {
          return;
        }
        const folder = chosen.trim();
        if (!isAbsolute(folder) || !isRepository(folder)) {
          say(paint.red(`${folder} is not an integr8-plus folder (no plan/requests/).`));
          return;
        }
        writeSettings({ ...readSettings(), repository: folder });
        say(paint.green(`Change requests are read from and handed over to ${folder}.`));
      },
    },
  ],
  versionLines: () => {
    const store = new SessionStore();
    const signedIn = store
      .list()
      .map((record) => `${record.api} (${record.email}, until ${record.sessionExpiresAt})`);
    return [
      `Signed in:     ${signedIn.length === 0 ? 'nowhere yet' : signedIn.join('; ')}`,
      `integr8-plus:  ${repositoryRoot() ?? 'not set'}`,
      `Describes API: ${repoVersion()}`,
    ];
  },
};
