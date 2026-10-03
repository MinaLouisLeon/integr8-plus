import { describe, expect, it } from 'vitest';
import { createLogger, principalContext } from './logger.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    service: 'integr8-api',
    release: 'abc123',
  });
  return { logger, lines };
}

describe('the shape of a line', () => {
  it('is JSON with a level, a time and a message', () => {
    const { logger, lines } = capture();
    logger.info('Something happened');

    expect(lines[0]).toMatchObject({
      level: 'info',
      time: '2026-09-10T12:00:00.000Z',
      message: 'Something happened',
      service: 'integr8-api',
      release: 'abc123',
    });
  });

  it('merges per-call fields', () => {
    const { logger, lines } = capture();
    logger.warn('Slow query', { durationMs: 1200 });

    expect(lines[0]?.durationMs).toBe(1200);
  });
});

describe('levels', () => {
  it('drops anything below the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', write: (line) => lines.push(line) });

    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');

    expect(lines).toHaveLength(2);
  });
});

describe('request correlation', () => {
  /**
   * P04's fourth exit criterion. Without this, "a customer says something
   * failed at about half past two" is not an answerable question.
   */
  it('puts the same request id on every line from one request', () => {
    const { logger, lines } = capture();
    const request = logger.child({ requestId: 'req-1', method: 'POST', path: '/v1/me' });

    request.info('Request started');
    request.info('Loaded the member');
    request.info('Request completed', { status: 200 });

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.requestId === 'req-1')).toBe(true);
    expect(lines.every((line) => line.path === '/v1/me')).toBe(true);
  });

  it('adds the principal without losing what the request already carried', () => {
    const { logger, lines } = capture();
    const request = logger.child({ requestId: 'req-1' });
    const authenticated = request.child({ tenantId: 'tenant-1', userId: 'user-1' });

    authenticated.info('Authenticated');

    expect(lines[0]).toMatchObject({
      requestId: 'req-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
    });
  });

  it('does not leak a child’s fields back into its parent', () => {
    const { logger, lines } = capture();
    const request = logger.child({ requestId: 'req-1' });
    request.child({ tenantId: 'tenant-1' }).info('Child');
    request.info('Parent');

    expect(lines[0]?.tenantId).toBe('tenant-1');
    expect(lines[1]?.tenantId).toBeUndefined();
  });
});

describe('redaction', () => {
  /**
   * A log line is copied into a ticket, a chat message, a screenshot. Anything
   * here would be a live credential the moment it were.
   */
  it('never writes a credential', () => {
    const { logger, lines } = capture();

    logger.info('Signed in', {
      email: 'dana@northwind.example',
      password: 'a perfectly good passphrase',
      accessToken: 'eyJ...',
      refreshToken: 'i8r1...',
      offlineGrant: 'eyJ...',
      idempotencyKey: 'key-1',
    });

    const line = lines[0] ?? {};
    expect(line.email).toBe('dana@northwind.example');
    for (const key of [
      'password',
      'accessToken',
      'refreshToken',
      'offlineGrant',
      'idempotencyKey',
    ]) {
      expect(line[key], key).toBe('[redacted]');
    }
  });

  it('redacts at any depth', () => {
    const { logger, lines } = capture();
    logger.info('Nested', { request: { headers: { authorization: 'Bearer eyJ...' } } });

    const request = lines[0]?.request as { headers: Record<string, unknown> };
    expect(request.headers.authorization).toBe('[redacted]');
  });

  it('redacts fields inherited from a parent logger too', () => {
    const { logger, lines } = capture();
    logger.child({ token: 'secret' }).info('Inherited');

    expect(lines[0]?.token).toBe('[redacted]');
  });

  it('leaves arrays alone rather than mangling them', () => {
    const { logger, lines } = capture();
    logger.info('List', { queues: ['audit.record', 'media.transcode'] });

    expect(lines[0]?.queues).toEqual(['audit.record', 'media.transcode']);
  });
});

describe('principalContext', () => {
  const principal = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    role: 'owner',
    sessionId: 'session-1',
    tokenId: 'token-1',
    expiresAt: new Date(),
  } as never;

  it('contributes the fields a log search needs', () => {
    expect(principalContext(principal)).toEqual({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('marks impersonation, so it is visible in every line', () => {
    const impersonated = {
      ...(principal as object),
      impersonatedBy: { pid: 'platform-1', gid: 'grant-1' },
    } as never;

    expect(principalContext(impersonated).impersonatedBy).toBe('platform-1');
  });
});
