import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Host } from '@integr8/forms-ai/setup';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  applyDevUpdate,
  checkForDevUpdate,
  DEV_PROFILE,
  devInstalledProgram,
  devInstallDir,
} from './program.js';
import { KEYRING_FILE, SessionStore } from './store.js';

/**
 * The developer MCP server as an installed program (P43): where it installs,
 * that the installer expects exactly the tools it serves, and that it updates
 * itself from the release list a signed-in API gives, refusing a download
 * that does not match its published checksum.
 */

const root = mkdtempSync(join(tmpdir(), 'dev-mcp-program-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const linux = (env: Record<string, string> = {}): Host => ({
  platform: 'linux',
  arch: 'x64',
  home: '/home/mina',
  env,
});

describe('where it installs', () => {
  it('has one fixed folder per user on each system', () => {
    expect(devInstalledProgram(linux())).toBe(
      '/home/mina/.local/share/integr8/dev-mcp/integr8-dev-mcp',
    );
    expect(
      devInstalledProgram({
        platform: 'win32',
        arch: 'x64',
        home: 'C:\\Users\\mina',
        env: { LOCALAPPDATA: 'C:\\Users\\mina\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\mina\\AppData\\Local\\Integr8\\dev-mcp\\integr8-dev-mcp.exe');
    expect(devInstallDir({ platform: 'darwin', arch: 'arm64', home: '/Users/mina', env: {} })).toBe(
      '/Users/mina/Library/Application Support/Integr8/dev-mcp',
    );
    expect(devInstallDir(linux({ INTEGR8_DEV_MCP_INSTALL: '/opt/dev' }))).toBe('/opt/dev');
  });

  it('is connected to AI tools as integr8-dev, with its keychain module beside it', () => {
    expect(DEV_PROFILE.serverName).toBe('integr8-dev');
    expect(DEV_PROFILE.companions).toEqual([KEYRING_FILE]);
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
    expect(ALL_TOOLS).toContain('call_website_api');
    expect(ALL_TOOLS).toContain('list_draft_change_requests');
  });
});

describe('updating itself', () => {
  const program = new TextEncoder().encode('new program bytes');
  const keyring = new TextEncoder().encode('new keyring bytes');
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

  const signedIn = async () => {
    const store = new SessionStore({
      platform: 'linux',
      home: root,
      env: { INTEGR8_DEV_MCP_HOME: join(root, 'config') },
    });
    await store.save(
      {
        api: 'https://api.example',
        email: 'dev@integr8.example',
        accessToken: 'access',
        refreshToken: 'refresh',
        sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        environment: 'staging',
      },
      'file',
    );
    return store;
  };

  const releaseFetch = (options: { programSum?: string } = {}): typeof fetch =>
    ((url: string | URL) => {
      const path = String(url);
      if (path === 'https://api.example/v1/platform/downloads') {
        return Promise.resolve(
          Response.json({
            devMcp: {
              status: 'found',
              release: {
                version: '2.1.0',
                downloads: [
                  {
                    name: 'integr8-dev-mcp-2.1.0-linux-x64',
                    url: 'https://files/p',
                    platform: 'linux',
                    arch: 'x64',
                    kind: 'program',
                    checksumUrl: 'https://files/p.sha256',
                  },
                  {
                    name: 'integr8-dev-mcp-keyring-2.1.0-linux-x64.node',
                    url: 'https://files/k',
                    platform: 'linux',
                    arch: 'x64',
                    kind: 'keyring',
                    checksumUrl: 'https://files/k.sha256',
                  },
                ],
              },
            },
          }),
        );
      }
      const files: Record<string, string | Uint8Array> = {
        'https://files/p': program,
        'https://files/p.sha256': `${options.programSum ?? sha(program)}  p`,
        'https://files/k': keyring,
        'https://files/k.sha256': sha(keyring),
      };
      const body = files[path];
      return Promise.resolve(
        body === undefined ? new Response(null, { status: 404 }) : new Response(body),
      );
    }) as typeof fetch;

  it('finds a newer version through a signed-in API, and nothing when it is current', async () => {
    const store = await signedIn();
    const offer = await checkForDevUpdate(linux(), '2.0.0', { store, fetch: releaseFetch() });
    expect(offer?.version).toBe('2.1.0');
    expect(offer?.name).toBe('integr8-dev-mcp-2.1.0-linux-x64');
    expect(
      await checkForDevUpdate(linux(), '2.1.0', { store, fetch: releaseFetch() }),
    ).toBeUndefined();
    const nobody = new SessionStore({
      platform: 'linux',
      home: root,
      env: { INTEGR8_DEV_MCP_HOME: join(root, 'nobody') },
    });
    expect(
      await checkForDevUpdate(linux(), '2.0.0', { store: nobody, fetch: releaseFetch() }),
    ).toBeUndefined();
  });

  it('replaces the program and the keychain module after checking both', async () => {
    const store = await signedIn();
    const offer = await checkForDevUpdate(linux(), '2.0.0', { store, fetch: releaseFetch() });
    const target = join(root, 'integr8-dev-mcp');
    writeFileSync(target, 'old program');
    writeFileSync(join(root, KEYRING_FILE), 'old keyring');
    await applyDevUpdate(offer!, target, { fetch: releaseFetch() });
    expect(readFileSync(target, 'utf8')).toBe('new program bytes');
    expect(readFileSync(join(root, KEYRING_FILE), 'utf8')).toBe('new keyring bytes');
  });

  it('changes nothing when a download does not match its checksum', async () => {
    const store = await signedIn();
    const bad = releaseFetch({ programSum: '0'.repeat(64) });
    const offer = await checkForDevUpdate(linux(), '2.0.0', { store, fetch: bad });
    const target = join(root, 'kept');
    writeFileSync(target, 'old program');
    await expect(applyDevUpdate(offer!, target, { fetch: bad })).rejects.toThrow(/checksum/u);
    expect(readFileSync(target, 'utf8')).toBe('old program');
  });
});

describe('the API release beside the one described', () => {
  it('says when they differ', async () => {
    const { releaseLine } = await import('./server.js');
    const { repoVersion } = await import('./paths.js');
    expect(releaseLine(repoVersion())).toMatch(/the routes this server describes/u);
    expect(releaseLine('99.0.0')).toMatch(/some routes may differ/u);
    expect(releaseLine('development')).toMatch(/API release: development \(this server describes/u);
    expect(releaseLine(undefined)).toMatch(/not reported/u);
  });
});
