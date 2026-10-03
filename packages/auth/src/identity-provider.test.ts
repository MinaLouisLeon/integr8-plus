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
      headers: (options.headers ?? {}) as Record<string, string>,
      body: JSON.parse(rawBody) as Record<string, unknown>,
    });

    return Promise.resolve(handler(url));
  };

  return {
    calls,
    provider: new SupabaseIdentityProvider({
      url: 'https://project.supabase.co/',
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

    expect(calls[0]?.url).toBe('https://project.supabase.co/auth/v1/token?grant_type=password');
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
      url: 'https://project.supabase.co',
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

describe('SupabaseIdentityProvider — magic links', () => {
  it('succeeds for an address that does not exist', async () => {
    // An endpoint that answered differently for a known address would be a
    // free membership oracle: paste in a list, learn who is a customer.
    const { provider } = supabase(() => new Response(null, { status: 200 }));

    await expect(
      provider.sendMagicLink('nobody@nowhere.example', 'https://app.integr8.example/callback'),
    ).resolves.toBeUndefined();
  });

  it('passes the redirect through', async () => {
    const { provider, calls } = supabase(() => new Response(null, { status: 200 }));

    await provider.sendMagicLink('dana@x.example', 'https://app.integr8.example/callback');

    expect(calls[0]?.body).toMatchObject({
      options: { email_redirect_to: 'https://app.integr8.example/callback' },
    });
  });

  it('rejects a spent or forged link as a credential failure', async () => {
    const { provider } = supabase(() => jsonResponse({ error: 'expired' }, 403));

    await expect(provider.verifyMagicLink('stale', 'dana@x.example')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });
});

describe('SupabaseIdentityProvider — creating an identity', () => {
  it('marks the address confirmed, because the invitation arrived in it', async () => {
    const { provider, calls } = supabase(() =>
      jsonResponse({ id: USER_ID, email: 'new@northwind.example' }),
    );

    await provider.createIdentity('new@northwind.example', 'a good password');

    expect(calls[0]?.url).toBe('https://project.supabase.co/auth/v1/admin/users');
    expect(calls[0]?.body).toMatchObject({
      email: 'new@northwind.example',
      email_confirm: true,
    });
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

  it('records magic links so a test can follow one', async () => {
    const provider = new FakeIdentityProvider(identities);
    await provider.sendMagicLink('dana@northwind.example', 'https://app/callback');

    const link = provider.magicLinks[0];
    expect(link?.email).toBe('dana@northwind.example');

    await expect(
      provider.verifyMagicLink(link?.token ?? '', 'dana@northwind.example'),
    ).resolves.toMatchObject({ userId: USER_ID });
  });

  it('refuses a magic-link token it never issued', async () => {
    const provider = new FakeIdentityProvider(identities);

    await expect(provider.verifyMagicLink('invented', 'dana@northwind.example')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('creates an identity, and is idempotent for one that exists', async () => {
    const provider = new FakeIdentityProvider(identities);

    const created = await provider.createIdentity('new@northwind.example', 'a good password');
    expect(created.email).toBe('new@northwind.example');

    const again = await provider.createIdentity('dana@northwind.example', 'ignored');
    expect(again.userId).toBe(USER_ID);
  });
});
