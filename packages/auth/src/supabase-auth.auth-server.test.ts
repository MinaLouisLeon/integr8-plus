import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidCredentialsError } from './errors.js';
import { SupabaseIdentityProvider } from './identity-provider.js';

/**
 * The identity provider against a real Supabase Auth container (P36).
 *
 * Every other suite uses the fake. This one proves the other side: that the
 * container, configured as `deploy/compose.yml` configures it, answers the
 * paths and shapes the provider expects — create, find, sign in, make a code,
 * verify it, set a password, delete. CI starts the container; locally:
 *
 *   SUPABASE_AUTH_URL=http://localhost:9999 SUPABASE_SERVICE_ROLE_KEY=… \
 *     pnpm --filter @integr8/auth test:auth-server
 */

const url = process.env.SUPABASE_AUTH_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

describe.skipIf(url === '' || serviceRoleKey === '')('Supabase Auth, for real', () => {
  const provider = new SupabaseIdentityProvider({ url, serviceRoleKey });
  const email = `contract.${randomUUID().slice(0, 8)}@test.integr8.example`;
  const password = 'a perfectly good passphrase';
  const changed = 'an entirely different passphrase';

  it('creates an identity, and refuses a second one for the same address', async () => {
    const created = await provider.createIdentity(email, password);
    expect(created.email).toBe(email);
    expect(created.emailVerified).toBe(true);
    await expect(provider.createIdentity(email, password)).rejects.toThrow(/422/u);
  });

  it('finds it by address, exactly', async () => {
    const found = await provider.findByEmail(email.toUpperCase());
    expect(found?.email).toBe(email);
    await expect(provider.findByEmail(`x${email}`)).resolves.toBeUndefined();
  });

  it('signs in with the password, and refuses a wrong one', async () => {
    await expect(provider.signInWithPassword(email, password)).resolves.toMatchObject({ email });
    await expect(provider.signInWithPassword(email, 'wrong password')).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('makes a 6-digit code without sending it, which signs in once', async () => {
    const code = await provider.createSignInCode(email);
    expect(code).toMatch(/^\d{6}$/u);

    await expect(provider.verifySignInCode(email, code)).resolves.toMatchObject({ email });
    await expect(provider.verifySignInCode(email, code)).rejects.toThrow(InvalidCredentialsError);
  });

  it('sets a new password', async () => {
    const identity = await provider.findByEmail(email);
    await provider.setPassword(identity?.userId ?? '', changed);

    await expect(provider.signInWithPassword(email, changed)).resolves.toMatchObject({ email });
    await expect(provider.signInWithPassword(email, password)).rejects.toThrow(
      InvalidCredentialsError,
    );
  });

  it('deletes the identity, and a second delete is still fine', async () => {
    const identity = await provider.findByEmail(email);
    await provider.deleteIdentity(identity?.userId ?? '');
    await provider.deleteIdentity(identity?.userId ?? '');
    await expect(provider.findByEmail(email)).resolves.toBeUndefined();
  });
});
