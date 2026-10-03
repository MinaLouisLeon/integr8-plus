'use client';

import { ApiRequestError, createClient, type Integr8Client } from '@integr8/api-client';

/**
 * The dashboard's session in the browser (P15).
 *
 * Deliberately a separate module from `session.ts`, with its own module state
 * and its own client, rather than the same code with a flag. Two sessions can
 * be open in one tab — a super admin signed in to the dashboard who is also
 * impersonating somebody — and if they shared a variable, one of them would
 * eventually answer for the other.
 *
 * The same split as the customer session: the refresh token never reaches
 * JavaScript, and the access token lives in memory for the life of the tab. A
 * platform access token lasts five minutes rather than fifteen, so this
 * refreshes more often, which is the price of a token that can reach every
 * company.
 */

let accessToken: string | null = null;
let expiresAt = 0;
let refreshing: Promise<string | null> | undefined;

const REFRESH_MARGIN_MS = 30_000;

export interface PlatformUser {
  id: string;
  email: string;
  displayName: string;
}

export async function signInToPlatform(
  email: string,
  password: string,
  code: string,
): Promise<PlatformUser> {
  const response = await fetch('/api/platform/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  });

  const body = (await response.json()) as
    | { accessToken: string; accessTokenExpiresAt: string; platformUser: PlatformUser }
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
  return body.platformUser;
}

export async function signOutOfPlatform(everywhere = false): Promise<void> {
  accessToken = null;
  expiresAt = 0;
  await fetch('/api/platform/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ everywhere }),
  });
}

/** Exchanges the httpOnly cookie for an access token, or null if there is no session. */
export async function ensurePlatformToken(): Promise<string | null> {
  if (accessToken !== null && Date.now() < expiresAt - REFRESH_MARGIN_MS) {
    return accessToken;
  }

  refreshing ??= refresh().finally(() => {
    refreshing = undefined;
  });

  return refreshing;
}

async function refresh(): Promise<string | null> {
  const response = await fetch('/api/platform/auth/refresh', { method: 'POST' });

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

/** The API client the dashboard's screens use. Its own instance, its own latch. */
export function platformClient(): Integr8Client {
  client ??= createClient({
    baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000',
    clientApp: 'web',
    clientVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    getAccessToken: () => ensurePlatformToken(),
    onUnauthorised: async () => {
      accessToken = null;
      return ensurePlatformToken();
    },
    onClientTooOld: ({ message }) => {
      console.warn(message);
    },
  });

  return client;
}
