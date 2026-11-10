import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configDir, normaliseApi } from './paths.js';
import { SessionStore } from './store.js';

const home = mkdtempSync(join(tmpdir(), 'dev-mcp-store-'));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const session = {
  api: 'https://api.example.com',
  email: 'dev@example.com',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  environment: 'staging' as const,
};

describe('the session store', () => {
  it('keeps a file-stored session only the user can read, and lists the API without secrets', async () => {
    const store = new SessionStore({
      platform: process.platform,
      home,
      env: { INTEGR8_DEV_MCP_HOME: join(home, 'config') },
    });
    await store.save(session, 'file');
    expect(await store.load(session.api)).toEqual(session);

    const index = readFileSync(join(home, 'config', 'apis.json'), 'utf8');
    expect(index).toContain('https://api.example.com');
    expect(index).not.toContain('secret');

    const [file] = readdirSync(join(home, 'config', 'sessions'));
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'config', 'sessions', file ?? '')).mode & 0o077).toBe(0);
    }

    await store.remove(session.api);
    expect(await store.load(session.api)).toBeUndefined();
    expect(readdirSync(join(home, 'config', 'sessions'))).toEqual([]);
  });
});

describe('addresses and folders', () => {
  it('spells an API one way, and refuses plain http to a remote one', () => {
    expect(normaliseApi('https://API.Example.com/')).toBe('https://api.example.com');
    expect(normaliseApi('http://127.0.0.1:3000/v1')).toBe('http://127.0.0.1:3000');
    expect(() => normaliseApi('http://api.example.com')).toThrow(/https/u);
  });

  it('keeps its configuration in the user’s own folder', () => {
    expect(configDir({ platform: 'linux', home: '/home/dev', env: {} })).toBe(
      '/home/dev/.config/integr8/dev-mcp',
    );
    expect(
      configDir({ platform: 'win32', home: 'C:\\Users\\dev', env: { APPDATA: 'C:\\Roaming' } }),
    ).toBe('C:\\Roaming\\Integr8\\dev-mcp');
  });
});
