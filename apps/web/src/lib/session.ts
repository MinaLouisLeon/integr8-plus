'use client';

import { ApiRequestError, createClient, type Integr8Client } from '@integr8/api-client';

/**
 * The browser's session, which is deliberately not the one the other two apps
 * use.
 *
 * Desktop and mobile keep a refresh token in the OS keychain and manage their
 * own rotation with `SessionManager`. A browser has no keychain, and the two
 * places a page can put a token are the two places a cross-site scripting bug
 * can read it. So on the web:
 *
 * - the **refresh token never reaches JavaScript at all**. It lives in an
 *   httpOnly cookie set by a Next route handler, which is the only thing that
 *   ever sees it;
 * - the **access token lives in memory** for the life of the tab. A reload
 *   loses it and gets a new one from the cookie, which costs one request.
 *
 * `localStorage` is not a third option. Any script on the page can read it,
 * which turns one XSS bug into every customer's data.
 */

let accessToken: string | null = null;
let expiresAt = 0;

/** Set when a refresh is in flight, so twenty 401s produce one refresh. */
let refreshing: Promise<string | null> | undefined;

const REFRESH_MARGIN_MS = 60_000;

export interface Membership {
  tenantId: string;
  role: string;
  status: string;
}

export interface SignInResult {
  tenantId: string;
  userId: string;
  memberships: Membership[];
}

export function signIn(email: string, password: string): Promise<SignInResult> {
  return signInThroughServer({ email, password });
}

/**
 * When this tab last signed in with an emailed code (P36). Only a hint for the
 * Change password screen, which leaves out the current password for fifteen
 * minutes afterwards; the API decides, and a reload forgets it.
 */
let signedInWithCodeAt: number | undefined;

const FRESH_CODE_SIGN_IN_MS = 15 * 60 * 1000;

/** Signs in with the 6-digit code from the email. Same cookie as a password. */
export async function signInWithCode(email: string, code: string): Promise<SignInResult> {
  const result = await signInThroughServer({ email, code });
  signedInWithCodeAt = Date.now();
  return result;
}

export function mayChangePasswordWithoutCurrent(): boolean {
  return (
    signedInWithCodeAt !== undefined && Date.now() - signedInWithCodeAt < FRESH_CODE_SIGN_IN_MS
  );
}

/**
 * Asks for a sign-in code by email. Straight to the API: nothing comes back
 * that needs a cookie. Answers the same whether or not the address has an
 * account; a 429 means wait a minute.
 */
export async function requestSignInCode(email: string, locale: 'en' | 'ar'): Promise<void> {
  const { error, response } = await apiClient().POST('/v1/auth/magic-link', {
    body: { email, locale },
  });
  if (error !== undefined) {
    throw toRequestError(response, error);
  }
}

/** Changes the password. Every other device is signed out; this tab is not. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
  locale: 'en' | 'ar';
}): Promise<void> {
  const { error, response } = await apiClient().POST('/v1/me/password', {
    body: {
      newPassword: input.newPassword,
      locale: input.locale,
      ...(input.currentPassword === '' ? {} : { currentPassword: input.currentPassword }),
    },
  });
  if (error !== undefined) {
    throw toRequestError(response, error);
  }
  signedInWithCodeAt = undefined;
}

function toRequestError(response: Response, error: unknown): ApiRequestError {
  const failure = (error as { error?: { code?: string; message?: string; requestId?: string } })
    .error;
  return new ApiRequestError(
    response.status,
    failure?.code ?? 'unknown_error',
    failure?.message ?? 'The request failed.',
    failure?.requestId ?? response.headers.get('x-request-id') ?? '',
  );
}

async function signInThroughServer(
  credentials: { email: string; password: string } | { email: string; code: string },
): Promise<SignInResult> {
  const response = await fetch('/api/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials),
  });

  const body = (await response.json()) as
    | (SignInResult & { accessToken: string; accessTokenExpiresAt: string })
    | { error: { code: string; message: string; requestId: string } };

  if (!response.ok || !('accessToken' in body)) {
    const failure = 'error' in body ? body.error : undefined;
    throw new ApiRequestError(
      response.status,
      failure?.code ?? 'unknown_error',
      failure?.message ?? 'Sign in failed.',
      failure?.requestId ?? '',
    );
  }

  remember(body.accessToken, body.accessTokenExpiresAt);

  return { tenantId: body.tenantId, userId: body.userId, memberships: body.memberships };
}

export async function signOut(): Promise<void> {
  accessToken = null;
  expiresAt = 0;
  await fetch('/api/auth/sign-out', { method: 'POST' });
}

/**
 * Exchanges the httpOnly cookie for an access token.
 *
 * Called on first render and whenever the current token is close to expiring.
 * Returns null when there is no usable session, which is how a guarded layout
 * knows to redirect.
 */
export async function ensureAccessToken(): Promise<string | null> {
  if (accessToken !== null && Date.now() < expiresAt - REFRESH_MARGIN_MS) {
    return accessToken;
  }

  refreshing ??= refresh().finally(() => {
    refreshing = undefined;
  });

  return refreshing;
}

async function refresh(): Promise<string | null> {
  const response = await fetch('/api/auth/refresh', { method: 'POST' });

  if (!response.ok) {
    accessToken = null;
    expiresAt = 0;
    return null;
  }

  const body = (await response.json()) as { accessToken: string; accessTokenExpiresAt: string };
  remember(body.accessToken, body.accessTokenExpiresAt);

  return body.accessToken;
}

function remember(token: string, expiry: string): void {
  accessToken = token;
  expiresAt = new Date(expiry).getTime();
}

let client: Integr8Client | undefined;

/**
 * The API client for browser code.
 *
 * Built once and reused, so the middleware and the refresh latch are shared
 * across every caller rather than re-created per component.
 */
export function apiClient(): Integr8Client {
  client ??= createClient({
    baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000',
    clientApp: 'web',
    clientVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    getAccessToken: () => ensureAccessToken(),
    onUnauthorised: async () => {
      // Force a round trip rather than returning the token we already know the
      // server just rejected.
      accessToken = null;
      return ensureAccessToken();
    },
    onClientTooOld: ({ message }) => {
      // The web app can always be updated by reloading, so this is a reload
      // prompt rather than a download link.
      console.warn(message);
    },
  });

  return client;
}
