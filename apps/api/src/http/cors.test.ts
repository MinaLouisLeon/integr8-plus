import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerCors } from './cors.js';

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
});
