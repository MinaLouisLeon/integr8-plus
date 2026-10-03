import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountLockedError,
  InvalidCredentialsError,
  InvalidTokenError,
  RefreshTokenReuseError,
  SessionRevokedError,
} from '../errors.js';
import {
  buildServices,
  createPlatformUser,
  releaseServices,
  type TestServices,
} from '../testing/harness.js';
import { totpCode } from '../totp.js';

/**
 * Signing a super admin in (P15).
 *
 * The dashboard can read every company's data, so what is tested here is not
 * that the happy path works but that each of the ways in is closed: one factor
 * is never enough, a wrong answer never says which half was wrong, repeated
 * guesses lock the account, and a spent refresh token ends the session rather
 * than issuing another one.
 */

let services: TestServices;
let account: Awaited<ReturnType<typeof createPlatformUser>>;
let secret: string;

const PASSWORD = 'correct horse battery staple 2026';

async function enrol(): Promise<string> {
  const enrolment = await services.platform.beginTotpEnrolment(account.id);
  const confirmed = await services.platform.confirmTotpEnrolment(
    account.id,
    totpCode(enrolment.secret),
  );
  expect(confirmed).toBe(true);
  return enrolment.secret;
}

beforeAll(async () => {
  services = await buildServices();
  account = await createPlatformUser();
  await services.platform.setPassword(account.id, PASSWORD);
  secret = await enrol();
});

afterAll(async () => {
  await releaseServices();
});

describe('signing in', () => {
  it('needs the password and the code together, and mints a token with no company in it', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });

    const principal = await services.platform.authenticate(signedIn.accessToken);

    expect(principal.platformUserId).toBe(account.id);
    expect(principal.sessionId).toBe(signedIn.sessionId);
    // No `tid` to read, which is the point of the third token type: nothing
    // that takes a tenant Principal can be handed this.
    expect(Object.keys(principal)).not.toContain('tenantId');

    // And a tenant handler asked to verify it refuses on the type alone.
    await expect(services.tokens.verifyAccessToken(signedIn.accessToken)).rejects.toThrow(
      InvalidTokenError,
    );
  });

  it('refuses the right password with the wrong code', async () => {
    await expect(
      services.platform.signIn({
        email: account.email,
        password: PASSWORD,
        code: '000000',
      }),
    ).rejects.toThrow(InvalidCredentialsError);
    await getPlatformDataSource().platformUsers.unlock(account.id);
  });

  it('refuses the right code with the wrong password', async () => {
    await expect(
      services.platform.signIn({
        email: account.email,
        password: 'not the password',
        code: totpCode(secret),
      }),
    ).rejects.toThrow(InvalidCredentialsError);
    await getPlatformDataSource().platformUsers.unlock(account.id);
  });

  /**
   * The messages, not just the types.
   *
   * `AuthError.message` reaches the caller through the API's error model, so a
   * message that named which of these it was would be a directory of super
   * admins — undoing the whole point of checking both factors either way.
   */
  it('answers every kind of failure with the same words', async () => {
    const disabled = await createPlatformUser();
    await services.platform.setPassword(disabled.id, PASSWORD);
    await getPlatformDataSource().platformUsers.setActive(disabled.id, false);

    const attempts = [
      // Unknown address.
      { email: 'nobody@test.integr8.example', password: PASSWORD, code: totpCode(secret) },
      // Known address, wrong password.
      { email: account.email, password: 'not the password', code: totpCode(secret) },
      // Known address, right password, wrong code.
      { email: account.email, password: PASSWORD, code: '000000' },
      // Right password, but the account has been turned off.
      { email: disabled.email, password: PASSWORD, code: '000000' },
    ];

    const messages = new Set<string>();
    for (const attempt of attempts) {
      await expect(services.platform.signIn(attempt)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(InvalidCredentialsError);
        messages.add((error as Error).message);
        return true;
      });
      await getPlatformDataSource().platformUsers.unlock(account.id);
    }

    expect(messages.size).toBe(1);
  });

  it('locks the account after enough wrong answers, and says so', async () => {
    const locked = await createPlatformUser();
    await services.platform.setPassword(locked.id, PASSWORD);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        services.platform.signIn({ email: locked.email, password: 'wrong', code: '000000' }),
      ).rejects.toThrow(InvalidCredentialsError);
    }

    // Now even the right answer is refused, and with a different error: the
    // person needs to know why waiting is the fix.
    await expect(
      services.platform.signIn({ email: locked.email, password: PASSWORD, code: '000000' }),
    ).rejects.toThrow(AccountLockedError);
  });

  it('refuses an account whose second factor is not enrolled', async () => {
    const halfway = await createPlatformUser();
    await services.platform.setPassword(halfway.id, PASSWORD);

    await expect(
      services.platform.signIn({
        email: halfway.email,
        password: PASSWORD,
        code: totpCode(secret),
      }),
    ).rejects.toThrow(InvalidCredentialsError);
    expect(await services.platform.setupNeeded(halfway.id)).toBe('second_factor');
  });

  it('stores the second-factor secret encrypted, never in the clear', async () => {
    const stored = await getPlatformDataSource().platformUsers.credentialsById(account.id);

    expect(stored?.totpSecret).toMatch(/^gcm1\./u);
    expect(stored?.totpSecret).not.toContain(secret);
  });
});

describe('staying signed in', () => {
  it('rotates the refresh token and keeps the session going', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });

    const refreshed = await services.platform.refresh(signedIn.refreshToken);

    expect(refreshed.sessionId).toBe(signedIn.sessionId);
    expect(refreshed.refreshToken).not.toBe(signedIn.refreshToken);
    await expect(services.platform.authenticate(refreshed.accessToken)).resolves.toMatchObject({
      sessionId: signedIn.sessionId,
    });
  });

  it('treats a spent refresh token as theft and ends the session', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });
    const second = await services.platform.refresh(signedIn.refreshToken);

    await expect(services.platform.refresh(signedIn.refreshToken)).rejects.toThrow(
      RefreshTokenReuseError,
    );

    // The replacement dies with the session, which is the point: the real
    // holder is signed out too, so they find out.
    await expect(services.platform.refresh(second.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
    await expect(services.platform.authenticate(second.accessToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  /**
   * The race, rather than the sequential case above.
   *
   * Two requests presenting the same token at the same moment both read it as
   * live. Only one may end up with a working session, and the other must be
   * treated as theft — a client racing itself and a thief racing the client are
   * the same fact from here, and the safe reading of the pair is theft.
   */
  it('lets only one of two simultaneous refreshes through, and ends the session', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });

    const [first, second] = await Promise.allSettled([
      services.platform.refresh(signedIn.refreshToken),
      services.platform.refresh(signedIn.refreshToken),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

    const loser = outcomes.find((result) => result.status === 'rejected');
    expect(loser?.reason).toBeInstanceOf(RefreshTokenReuseError);

    // And the winner's brand new token is dead too, because the session is.
    const winner = outcomes.find((result) => result.status === 'fulfilled');
    expect(winner).toBeDefined();
    await expect(services.platform.refresh(winner!.value.refreshToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('never extends a session past its ceiling, however often it is refreshed', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });
    const before = await getPlatformDataSource().platformSessions.find(signedIn.sessionId);

    await services.platform.refresh(signedIn.refreshToken);

    const after = await getPlatformDataSource().platformSessions.find(signedIn.sessionId);
    expect(after?.expiresAt.getTime()).toBe(before?.expiresAt.getTime());
  });

  it('stops accepting a token the moment its session is signed out', async () => {
    const signedIn = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });
    await expect(services.platform.authenticate(signedIn.accessToken)).resolves.toBeDefined();

    await services.platform.signOut(signedIn.sessionId);

    await expect(services.platform.authenticate(signedIn.accessToken)).rejects.toThrow(
      SessionRevokedError,
    );
  });

  it('signs every browser out when the password changes', async () => {
    const one = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });
    const two = await services.platform.signIn({
      email: account.email,
      password: PASSWORD,
      code: totpCode(secret),
    });

    await services.platform.setPassword(account.id, PASSWORD);

    for (const session of [one, two]) {
      await expect(services.platform.authenticate(session.accessToken)).rejects.toThrow(
        SessionRevokedError,
      );
    }
  });
});

describe('enrolling a second factor', () => {
  it('does not enrol until a code from the new secret is confirmed', async () => {
    const pending = await createPlatformUser();
    await services.platform.setPassword(pending.id, PASSWORD);

    const enrolment = await services.platform.beginTotpEnrolment(pending.id);
    expect(await services.platform.setupNeeded(pending.id)).toBe('second_factor');
    expect(enrolment.uri).toContain('otpauth://totp/');

    expect(await services.platform.confirmTotpEnrolment(pending.id, '000000')).toBe(false);
    expect(await services.platform.setupNeeded(pending.id)).toBe('second_factor');

    expect(
      await services.platform.confirmTotpEnrolment(pending.id, totpCode(enrolment.secret)),
    ).toBe(true);
    expect(await services.platform.setupNeeded(pending.id)).toBeUndefined();
  });

  it('will not confirm the same enrolment twice', async () => {
    const code = totpCode(secret);

    expect(await services.platform.confirmTotpEnrolment(account.id, code)).toBe(false);
  });
});
