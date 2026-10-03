import { describe, expect, it } from 'vitest';
import { type ApiRequestError, createClient } from './index.js';

/**
 * The client's own behaviour: the headers it always sends, how it turns a
 * failure response into a thrown error, and the single retry after a refresh.
 *
 * The generated types are checked by the compiler — three apps import this
 * package, and `pnpm build` is what proves the contract still fits them. What
 * needs testing is the runtime wrapper around them.
 */

const REQUEST_ID = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

function stub(handler: (call: number) => Response) {
  const calls: Recorded[] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Read as a real server would, so a retry that re-sends a consumed body
    // fails here the way it fails in production.
    const body = request.body === null ? null : await request.text();
    calls.push({ url: request.url, headers, body });
    return handler(calls.length);
  };

  return { calls, fetchImpl };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorBody(code: string, message: string) {
  return { error: { code, message, requestId: REQUEST_ID } };
}

describe('what every request carries', () => {
  it('sends the app and its build, so the server can say this one is too old', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse({ userId: 'u' }, 200));

    const client = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'mobile',
      clientVersion: '1.4.2',
      getAccessToken: () => null,
      fetch: fetchImpl,
    });

    await client.GET('/v1/me');

    expect(calls[0]?.headers['x-client-app']).toBe('mobile');
    expect(calls[0]?.headers['x-client-version']).toBe('1.4.2');
  });

  it('attaches a bearer token when there is one', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse({}, 200));

    const client = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'token-1',
      fetch: fetchImpl,
    });

    await client.GET('/v1/me');
    expect(calls[0]?.headers.authorization).toBe('Bearer token-1');
  });

  it('sends no authorization header when signed out', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse({}, 200));

    const client = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => null,
      fetch: fetchImpl,
    });

    await client.GET('/v1/me');
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('awaits an async token source, so a keychain read works', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse({}, 200));

    const client = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'desktop',
      clientVersion: '1.0.0',
      getAccessToken: () => Promise.resolve('from-keychain'),
      fetch: fetchImpl,
    });

    await client.GET('/v1/me');
    expect(calls[0]?.headers.authorization).toBe('Bearer from-keychain');
  });

  it('tolerates a base URL with a trailing slash', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse({}, 200));

    const client = createClient({
      baseUrl: 'https://api.integr8.example///',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => null,
      fetch: fetchImpl,
    });

    await client.GET('/v1/me');
    expect(calls[0]?.url).toBe('https://api.integr8.example/v1/me');
  });
});

describe('failures', () => {
  function client(handler: (call: number) => Response, overrides = {}) {
    const { calls, fetchImpl } = stub(handler);
    return {
      calls,
      client: createClient({
        baseUrl: 'https://api.integr8.example',
        clientApp: 'web',
        clientVersion: '1.0.0',
        getAccessToken: () => 'token-1',
        fetch: fetchImpl,
        ...overrides,
      }),
    };
  }

  it('throws with the code, message and request id from the body', async () => {
    const { client: api } = client(() => jsonResponse(errorBody('forbidden', 'Not allowed'), 403));

    await expect(api.GET('/v1/me')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Not allowed',
      requestId: REQUEST_ID,
    });
  });

  it('carries field-level details through', async () => {
    const { client: api } = client(() =>
      jsonResponse(
        {
          error: {
            code: 'validation_failed',
            message: 'Invalid',
            requestId: REQUEST_ID,
            details: [{ field: 'body.email', code: 'too_small', message: 'Too short' }],
          },
        },
        422,
      ),
    );

    try {
      await api.GET('/v1/me');
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as ApiRequestError;
      expect(failure.isValidation).toBe(true);
      expect(failure.details[0]?.field).toBe('body.email');
    }
  });

  it('falls back to the status when a proxy returns an HTML error page', async () => {
    // A load balancer between the client and the server does not know the error
    // model. Failing while reporting a failure is the worst possible outcome.
    const { client: api } = client(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    await expect(api.GET('/v1/me')).rejects.toMatchObject({
      status: 502,
      code: 'unknown_error',
    });
  });

  it('reads the request id from the header when the body has none', async () => {
    const { client: api } = client(
      () => new Response('nope', { status: 500, headers: { 'x-request-id': REQUEST_ID } }),
    );

    await expect(api.GET('/v1/me')).rejects.toMatchObject({ requestId: REQUEST_ID });
  });

  it('flags a rate limit and an out-of-date build', async () => {
    const limited = client(() => jsonResponse(errorBody('rate_limited', 'Slow down'), 429));
    await expect(limited.client.GET('/v1/me')).rejects.toMatchObject({ isRateLimited: true });

    const old = client(() => jsonResponse(errorBody('client_too_old', 'Update'), 503));
    await expect(old.client.GET('/v1/me')).rejects.toMatchObject({ isClientTooOld: true });
  });

  it('tells the app when this build is too old, with the minimum from the header', async () => {
    const seen: { minimum: string; message: string }[] = [];
    const { client: api } = client(
      () =>
        jsonResponse(errorBody('client_too_old', 'Please update'), 503, {
          'min-supported-client': '2.0.0',
        }),
      { onClientTooOld: (info: { minimum: string; message: string }) => seen.push(info) },
    );

    await expect(api.GET('/v1/me')).rejects.toThrow();

    expect(seen[0]).toEqual({ minimum: '2.0.0', message: 'Please update' });
  });
});

describe('refreshing after a 401', () => {
  it('retries once with the new token', async () => {
    const { calls, fetchImpl } = stub((call) =>
      call === 1
        ? jsonResponse(errorBody('unauthorised', 'Authentication is required'), 401)
        : jsonResponse({ userId: 'u' }, 200),
    );

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'expired',
      onUnauthorised: () => Promise.resolve('refreshed'),
      fetch: fetchImpl,
    });

    const { data } = await api.GET('/v1/me');

    expect(data).toEqual({ userId: 'u' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers.authorization).toBe('Bearer expired');
    expect(calls[1]?.headers.authorization).toBe('Bearer refreshed');
  });

  it('retries a request that carries a body, with the same body', async () => {
    // The body is consumed by the first send. A retry built from the sent
    // request would throw rather than retry, and every mutation in every app
    // would fail on an expired token where a read would have recovered.
    const { calls, fetchImpl } = stub((call) =>
      call === 1
        ? jsonResponse(errorBody('unauthorised', 'Authentication is required'), 401)
        : jsonResponse({ recorded: true }, 202),
    );

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'expired',
      onUnauthorised: () => Promise.resolve('refreshed'),
      fetch: fetchImpl,
    });

    const { response } = await api.POST('/v1/signup/step', { body: { step: 'landing.viewed' } });

    expect(response.status).toBe(202);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.authorization).toBe('Bearer refreshed');
    expect(calls[1]?.body).toBe(JSON.stringify({ step: 'landing.viewed' }));
    expect(calls[1]?.body).toBe(calls[0]?.body);
  });

  it('retries only once, however many times the server says no', async () => {
    // If a freshly refreshed token is also rejected, the problem is not the
    // token, and retrying would turn one failure into a storm against a server
    // that has already said no twice.
    const { calls, fetchImpl } = stub(() =>
      jsonResponse(errorBody('unauthorised', 'Authentication is required'), 401),
    );

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'expired',
      onUnauthorised: () => Promise.resolve('also-expired'),
      fetch: fetchImpl,
    });

    await expect(api.GET('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(2);
  });

  it('gives up when the refresh returns nothing', async () => {
    const { calls, fetchImpl } = stub(() =>
      jsonResponse(errorBody('unauthorised', 'Authentication is required'), 401),
    );

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'expired',
      onUnauthorised: () => Promise.resolve(null),
      fetch: fetchImpl,
    });

    await expect(api.GET('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('does not refresh when no handler was provided', async () => {
    const { calls, fetchImpl } = stub(() =>
      jsonResponse(errorBody('unauthorised', 'Authentication is required'), 401),
    );

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'expired',
      fetch: fetchImpl,
    });

    await expect(api.GET('/v1/me')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('does not refresh on a 403, which a new token would not fix', async () => {
    const { calls, fetchImpl } = stub(() => jsonResponse(errorBody('forbidden', 'No'), 403));

    const api = createClient({
      baseUrl: 'https://api.integr8.example',
      clientApp: 'web',
      clientVersion: '1.0.0',
      getAccessToken: () => 'token-1',
      onUnauthorised: () => Promise.resolve('refreshed'),
      fetch: fetchImpl,
    });

    await expect(api.GET('/v1/me')).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });
});
