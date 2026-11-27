import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trustEdgeOnly } from './trust-proxy.js';

/**
 * The address the API sees for a visitor, behind the edge container. Fastify answers
 * `request.ip`; these cases are the ones that decide who a rate limit or an audit line blames.
 */

async function ipSeenFor(headers: Record<string, string>, remoteAddress = '172.20.0.5') {
  const app = Fastify({ logger: false, trustProxy: trustEdgeOnly });
  app.get('/ip', (request) => ({ ip: request.ip }));
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/ip', headers, remoteAddress });
  await app.close();
  return response.json<{ ip: string }>().ip;
}

describe('trusting only the edge container', () => {
  it('takes the address the edge sends', async () => {
    expect(await ipSeenFor({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('uses the connection itself when no proxy is in front (development, tests)', async () => {
    expect(await ipSeenFor({})).toBe('172.20.0.5');
  });

  it('is not fooled by a visitor writing their own address to the left', async () => {
    // What reaches the API if a proxy ever appended instead of replacing: the visitor's
    // forged value first, the real one last.
    expect(await ipSeenFor({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' })).toBe('203.0.113.7');
  });

  it('would have been, with trustProxy: true (why this module exists)', async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    app.get('/ip', (request) => ({ ip: request.ip }));
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
      remoteAddress: '172.20.0.5',
    });
    await app.close();
    expect(response.json<{ ip: string }>().ip).toBe('6.6.6.6');
  });

  it('trusts the first hop and no other', () => {
    expect(trustEdgeOnly('172.20.0.5', 0)).toBe(true);
    expect(trustEdgeOnly('203.0.113.7', 1)).toBe(false);
    expect(trustEdgeOnly('10.0.0.1', 2)).toBe(false);
  });
});
