import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isReportableOrigin,
  MAX_ORIGIN_LENGTH,
  REFUSED_ORIGIN_MEMORY,
  registerCors,
} from './cors.js';

/**
 * The browser-facing half of CORS: what a preflight gets back, and that a
 * refused origin is reported rather than silently 403'd.
 */

const ALLOWED = ['https://app.example.com', 'tauri://localhost'];

async function server(onRefused?: (origin: string) => void) {
  const app = Fastify({ logger: false });
  registerCors(app, ALLOWED, onRefused);
  app.get('/thing', () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('CORS', () => {
  const apps: Awaited<ReturnType<typeof server>>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('answers a preflight from an allowed origin with the headers the browser needs', async () => {
    const app = await server();
    apps.push(app);

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/thing',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-client-app',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-allow-methods']).toContain('GET');
  });

  it('refuses a preflight from an unknown origin, and says so once per origin', async () => {
    const refused: string[] = [];
    const app = await server((origin) => refused.push(origin));
    apps.push(app);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/thing',
        headers: { origin: 'https://app.exarnple.com', 'access-control-request-method': 'GET' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }

    // A plain request from the same wrong origin is served (the browser hides
    // the response) but is not reported again.
    const plain = await app.inject({
      method: 'GET',
      url: '/thing',
      headers: { origin: 'https://app.exarnple.com' },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['access-control-allow-origin']).toBeUndefined();

    expect(refused).toEqual(['https://app.exarnple.com']);
  });

  it('says nothing about requests with no origin at all', async () => {
    const refused: string[] = [];
    const app = await server((origin) => refused.push(origin));
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/thing' });
    expect(response.statusCode).toBe(200);
    expect(refused).toEqual([]);
  });

  it('ignores a malformed or over-long origin: refused, never kept, never logged', async () => {
    const refused: string[] = [];
    const app = await server((origin) => refused.push(origin));
    apps.push(app);

    const long = `https://${'a'.repeat(MAX_ORIGIN_LENGTH)}.example.com`;
    for (const origin of ['not an origin', 'https://app.example.com/path', 'null', long]) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/thing',
        headers: { origin, 'access-control-request-method': 'GET' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }

    expect(refused).toEqual([]);
  });

  it('remembers the last thousand refused origins, forgetting the oldest first', async () => {
    const refused: string[] = [];
    const app = await server((origin) => refused.push(origin));
    apps.push(app);

    const ask = (origin: string) =>
      app.inject({ method: 'GET', url: '/thing', headers: { origin } });

    for (let index = 0; index <= REFUSED_ORIGIN_MEMORY; index += 1) {
      await ask(`https://stranger-${String(index)}.example.com`);
    }
    expect(refused).toHaveLength(REFUSED_ORIGIN_MEMORY + 1);

    // The newest is still remembered; the very first has been forgotten, so it
    // is reported again.
    await ask(`https://stranger-${String(REFUSED_ORIGIN_MEMORY)}.example.com`);
    expect(refused).toHaveLength(REFUSED_ORIGIN_MEMORY + 1);
    await ask('https://stranger-0.example.com');
    expect(refused).toHaveLength(REFUSED_ORIGIN_MEMORY + 2);
  });
});

describe('which origins are reported', () => {
  it('takes what browsers send, including the Tauri webview and a port', () => {
    expect(isReportableOrigin('https://app.example.com')).toBe(true);
    expect(isReportableOrigin('http://localhost:3001')).toBe(true);
    expect(isReportableOrigin('tauri://localhost')).toBe(true);
    expect(isReportableOrigin('http://[::1]:3000')).toBe(true);
  });

  it('leaves out anything else', () => {
    expect(isReportableOrigin('')).toBe(false);
    expect(isReportableOrigin('https://app.example.com/')).toBe(false);
    expect(isReportableOrigin('https://exa mple.com')).toBe(false);
    expect(isReportableOrigin('javascript:alert(1)')).toBe(false);
    expect(isReportableOrigin(`https://${'a'.repeat(MAX_ORIGIN_LENGTH)}`)).toBe(false);
  });
});
