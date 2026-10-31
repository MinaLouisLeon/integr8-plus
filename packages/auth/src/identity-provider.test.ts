import { describe, expect, it } from 'vitest';
import { IdentityProviderError, InvalidCredentialsError } from './errors.js';
import { FakeIdentityProvider, SupabaseIdentityProvider } from './identity-provider.js';

const USER_ID = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A Supabase provider over a recording `fetch`.
 *
 * The calls are captured as plain data rather than through a mock's untyped
 * argument tuple, so the assertions below read as "what was sent" instead of
 * as a sequence of casts.
 */
function supabase(handler: (url: string) => Response) {
  const calls: RecordedCall[] = [];

  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const options = init ?? {};
    const rawBody = typeof options.body === 'string' ? options.body : '{}';

    calls.push({
      url,
      method: options.method ?? 'GET',
      headers: (options.headers ?? {}) as Record<string, string>,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });

    return Promise.resolve(handler(url));
  };

  return {
    calls,
    provider: new SupabaseIdentityProvider({
      url: 'http://auth:9999/',
      serviceRoleKey: 'service-role-key',
      fetch: fetchImpl,
    }),
  };
}

describe('SupabaseIdentityProvider — password sign-in', () => {
  it('exchanges a password for an identity', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({
        user: { id: USER_ID, email: 'Dana@Northwind.example', email_confirmed_at: '2026-01-01' },
      }),
    );

    const identity = await provider.signInWithPassword('Dana@Northwind.example', 'a good password');

    expect(identity).toEqual({
      userId: USER_ID,
      email: 'dana@northwind.example',
      emailVerified: true,
    });

    expect(calls[0]?.url).toBe('http://auth:9999/token?grant_type=password');
    expect(calls[0]?.headers).toMatchObject({
      apikey: 'service-role-key',
      authorization: 'Bearer service-role-key',
    });
  });

  it('lowercases the address on the way out', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({ user: { id: USER_ID, email: 'dana@northwind.example' } }),
    );

    await provider.signInWithPassword('  DANA@Northwind.example ', 'password');

    expect(calls[0]?.body).toMatchObject({ email: 'dana@northwind.example' });
  });

  it('turns a rejected credential into one indistinguishable error', async () => {
    // GoTrue answers 400 for both a wrong password and an unknown address, and
    // that is the right shape: the caller learns only that it failed.
    for (const status of [400, 401]) {
      const { provider } = supabase(() => jsonResponse({ error: 'invalid' }, status));
      await expect(provider.signInWithPassword('dana@x.example', 'wrong')).rejects.toThrow(
        InvalidCredentialsError,
      );
    }
  });

  it('reports an outage as an outage, not as a bad password', async () => {
    const { provider } = supabase(() => jsonResponse({}, 503));
    await expect(provider.signInWithPassword('dana@x.example', 'password')).rejects.toThrow(
      IdentityProviderError,
    );
  });

  it('reports a network failure as an outage', async () => {
    const provider = new SupabaseIdentityProvider({
      url: 'http://auth:9999',
      serviceRoleKey: 'k',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    await expect(provider.signInWithPassword('dana@x.example', 'password')).rejects.toThrow(
      /Could not reach the identity provider/u,
    );
  });

  it('treats an unconfirmed address as unverified rather than failing', async () => {
    const { provider } = supabase(() =>
      jsonResponse({ user: { id: USER_ID, email: 'dana@x.example', email_confirmed_at: null } }),
    );

    await expect(provider.signInWithPassword('dana@x.example', 'password')).resolves.toMatchObject({
      emailVerified: false,
    });
  });
});

describe('SupabaseIdentityProvider — the base address', () => {
  it('joins paths to the container address as given, with no /auth/v1', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({ user: { id: USER_ID, email: 'dana@x.example' } }),
    );
    await provider.signInWithPassword('dana@x.example', 'password');
    expect(calls[0]?.url.startsWith('http://auth:9999/token')).toBe(true);
    expect(calls[0]?.url).not.toContain('/auth/v1');
  });
});

describe('SupabaseIdentityProvider — sign-in codes', () => {
  it('makes a code through the admin API without sending anything', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({
        id: USER_ID,
        email: 'dana@x.example',
        action_link: 'http://auth:9999/verify?token=abc',
        email_otp: '123456',
        hashed_token: 'abc',
        verification_type: 'magiclink',
      }),
    );

    await expect(provider.createSignInCode(' Dana@X.example ')).resolves.toBe('123456');
    expect(calls[0]?.url).toBe('http://auth:9999/admin/generate_link');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ type: 'magiclink', email: 'dana@x.example' });
  });

  it('verifies a code for an identity', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({ user: { id: USER_ID, email: 'dana@x.example', email_confirmed_at: 'x' } }),
    );

    await expect(provider.verifySignInCode('dana@x.example', ' 123456 ')).resolves.toMatchObject({
      userId: USER_ID,
    });
    expect(calls[0]?.url).toBe('http://auth:9999/verify');
    expect(calls[0]?.body).toEqual({
      type: 'magiclink',
      token: '123456',
      email: 'dana@x.example',
    });
  });

  it('rejects a wrong, spent or expired code as a credential failure', async () => {
    for (const status of [400, 401, 403]) {
      const { provider } = supabase(() => jsonResponse({ error: 'expired' }, status));
      await expect(provider.verifySignInCode('dana@x.example', '000000')).rejects.toThrow(
        InvalidCredentialsError,
      );
    }
  });
});

describe('SupabaseIdentityProvider — passwords and deletion', () => {
  it('sets a password with PUT on the admin user', async () => {
    const { provider, calls } = supabase(() => jsonResponse({ id: USER_ID }));
    await provider.setPassword(USER_ID, 'a new good password');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe(`http://auth:9999/admin/users/${USER_ID}`);
    expect(calls[0]?.body).toEqual({ password: 'a new good password' });
  });

  it('reports a failed password change as an outage', async () => {
    const { provider } = supabase(() => jsonResponse({}, 500));
    await expect(provider.setPassword(USER_ID, 'x')).rejects.toThrow(IdentityProviderError);
  });

  it('deletes with DELETE, and treats an identity already gone as done', async () => {
    const ok = supabase(() => jsonResponse({}));
    await ok.provider.deleteIdentity(USER_ID);
    expect(ok.calls[0]?.method).toBe('DELETE');
    expect(ok.calls[0]?.url).toBe(`http://auth:9999/admin/users/${USER_ID}`);

    const gone = supabase(() => jsonResponse({ msg: 'User not found' }, 404));
    await expect(gone.provider.deleteIdentity(USER_ID)).resolves.toBeUndefined();

    const down = supabase(() => jsonResponse({}, 503));
    await expect(down.provider.deleteIdentity(USER_ID)).rejects.toThrow(IdentityProviderError);
  });
});

describe('SupabaseIdentityProvider — creating an identity', () => {
  it('marks the address confirmed, because the invitation arrived in it', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({ id: USER_ID, email: 'new@northwind.example' }),
    );

    await provider.createIdentity('new@northwind.example', 'a good password');

    expect(calls[0]?.url).toBe('http://auth:9999/admin/users');
    expect(calls[0]?.body).toMatchObject({
      email: 'new@northwind.example',
      email_confirm: true,
    });
  });

  it('refuses an address that already has one, as GoTrue does', async () => {
    const { provider } = supabase(() =>
      jsonResponse(
        { code: 422, msg: 'A user with this email address has already been registered' },
        422,
      ),
    );

    await expect(
      provider.createIdentity('dana@northwind.example', 'a good password'),
    ).rejects.toThrow(IdentityProviderError);
  });
});

describe('SupabaseIdentityProvider — finding an identity', () => {
  /**
   * GoTrue's admin list has no exact-match parameter: `filter` is a substring
   * `LIKE` over the address, so `a@northwind.example` also returns
   * `dana@northwind.example`. The provider asks with the whole address and
   * picks the exact match out itself.
   */
  it('asks the admin list with the address and picks the exact match', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({
        users: [
          { id: '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6072', email: 'dana@northwind.example' },
          { id: USER_ID, email: 'a@northwind.example', email_confirmed_at: '2026-01-01' },
        ],
      }),
    );

    const found = await provider.findByEmail(' A@Northwind.example ');

    expect(calls[0]?.url).toBe(
      'http://auth:9999/admin/users?filter=a%40northwind.example&page=1&per_page=100',
    );
    expect(calls[0]?.headers.authorization).toBe('Bearer service-role-key');
    expect(found).toEqual({ userId: USER_ID, email: 'a@northwind.example', emailVerified: true });
  });

  it('answers undefined when only near-misses come back, or nothing does', async () => {
    const nearMiss = supabase(() =>
      jsonResponse({ users: [{ id: USER_ID, email: 'dana@northwind.example' }] }),
    );
    await expect(nearMiss.provider.findByEmail('a@northwind.example')).resolves.toBeUndefined();

    const nobody = supabase(() => jsonResponse({ users: [] }));
    await expect(nobody.provider.findByEmail('a@northwind.example')).resolves.toBeUndefined();
  });

  it('reports a provider failure rather than treating it as "no such address"', async () => {
    // Undefined here would send the caller on to create a duplicate, which
    // GoTrue refuses — a confusing failure in place of the real one.
    const { provider } = supabase(() => jsonResponse({ msg: 'nope' }, 500));

    await expect(provider.findByEmail('a@northwind.example')).rejects.toThrow(
      IdentityProviderError,
    );
  });
});

describe('FakeIdentityProvider', () => {
  const identities = [
    { userId: USER_ID, email: 'dana@northwind.example', password: 'a good password' },
  ];

  it('accepts the right password and rejects the wrong one', async () => {
    const provider = new FakeIdentityProvider(identities);

    await expect(
      provider.signInWithPassword('dana@northwind.example', 'a good password'),
    ).resolves.toMatchObject({ userId: USER_ID });

    await expect(provider.signInWithPassword('dana@northwind.example', 'wrong')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('rejects an unknown address the same way as a wrong password', async () => {
    const provider = new FakeIdentityProvider(identities);

    await expect(provider.signInWithPassword('nobody@x.example', 'anything')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('makes a code a test can follow, usable once, replaced by the next', async () => {
    const provider = new FakeIdentityProvider(identities);
    const first = await provider.createSignInCode('dana@northwind.example');
    const second = await provider.createSignInCode('dana@northwind.example');
    expect(second).toMatch(/^\d{6}$/u);
    expect(provider.latestCode('dana@northwind.example')).toBe(second);

    await expect(provider.verifySignInCode('dana@northwind.example', first)).rejects.toThrow(
      InvalidCredentialsError,
    );
    await expect(
      provider.verifySignInCode('dana@northwind.example', second),
    ).resolves.toMatchObject({ userId: USER_ID });
    await expect(provider.verifySignInCode('dana@northwind.example', second)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('refuses a code for an address with no identity, as GoTrue does', async () => {
    const provider = new FakeIdentityProvider(identities);
    await expect(provider.createSignInCode('nobody@northwind.example')).rejects.toThrow(
      IdentityProviderError,
    );
  });

  it('sets a password and deletes an identity', async () => {
    const provider = new FakeIdentityProvider([...identities]);
    await provider.setPassword(USER_ID, 'another good password');
    expect(provider.passwordOf('dana@northwind.example')).toBe('another good password');

    await provider.deleteIdentity(USER_ID);
    expect(provider.deleted).toEqual([USER_ID]);
    await expect(provider.findByEmail('dana@northwind.example')).resolves.toBeUndefined();
  });

  it('creates an identity, and refuses a duplicate the way GoTrue does', async () => {
    const provider = new FakeIdentityProvider(identities);

    const created = await provider.createIdentity('new@northwind.example', 'a good password');
    expect(created.email).toBe('new@northwind.example');

    // It used to hand back the existing identity here, which let two callers
    // that never looked before creating pass their suites and fail in
    // production. A double kinder than the real thing passes the wrong tests.
    await expect(provider.createIdentity('dana@northwind.example', 'ignored')).rejects.toThrow(
      IdentityProviderError,
    );
  });

  it('finds an identity by address, however it is cased, and nobody otherwise', async () => {
    const provider = new FakeIdentityProvider(identities);

    await expect(provider.findByEmail(' Dana@Northwind.example ')).resolves.toMatchObject({
      userId: USER_ID,
      email: 'dana@northwind.example',
    });
    await expect(provider.findByEmail('nobody@northwind.example')).resolves.toBeUndefined();
  });
});
