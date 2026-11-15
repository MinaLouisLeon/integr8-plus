import { createClient, type Integr8Client } from '@integr8/api-client';
import { reportClientTooOld } from '~/lib/client-update';
import { APP_VERSION, API_BASE_URL, COMPANY_SLUG } from '~/lib/env';
import { session } from '~/lib/session';
import { registerStaffBridge } from '~/lib/staff-bridge';

/**
 * Integr8 staff signed in to the staff desktop app (P42).
 *
 * The staff app is the staff dashboard now: companies, plans, flags,
 * templates and the rest, and working inside a company to build its forms and
 * set its look. Both run on a platform session, which can reach every company,
 * so it is kept **in memory only** (the owner's decision D2): nothing about it
 * is written to the credential store, staff sign in with their password and
 * authenticator code each time the app starts, and closing the app ends it.
 *
 * A separate module from `~/lib/session`, with its own client and its own
 * state, for the reason the web dashboard kept them apart: two sessions are
 * open at once while staff work inside a company, and if they shared anything
 * one would eventually answer for the other.
 *
 * Platform access tokens last five minutes and are refreshed with the refresh
 * token held here, rotated on every refresh. The session itself ends at its
 * fixed limit (eight hours) whatever happens.
 */

export interface StaffUser {
  id: string;
  email: string;
  displayName: string;
}

interface Tokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
}

const REFRESH_MARGIN_MS = 30_000;

let tokens: Tokens | null = null;
let user: StaffUser | null = null;
let refreshing: Promise<string | null> | undefined;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Called whenever the platform session starts or ends, for the screens that show it. */
export function onPlatformSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function staffUser(): StaffUser | null {
  return user;
}

export function hasPlatformSession(): boolean {
  return tokens !== null;
}

/**
 * The client for signing in and refreshing: it sends no token of its own, so
 * a refresh can never recurse into another refresh.
 */
let bare: Integr8Client | undefined;
function bareClient(): Integr8Client {
  bare ??= createClient({
    baseUrl: API_BASE_URL,
    clientApp: 'desktop',
    clientVersion: APP_VERSION,
    getAccessToken: () => Promise.resolve(null),
    onUnauthorised: () => Promise.resolve(null),
    onClientTooOld: (info) => {
      reportClientTooOld(info, COMPANY_SLUG);
    },
  });
  return bare;
}

export async function staffSignIn(input: {
  email: string;
  password: string;
  code: string;
}): Promise<StaffUser> {
  const { data } = await bareClient().POST('/v1/platform/auth/sign-in', { body: input });
  tokens = data!.tokens;
  user = data!.platformUser;
  changed();
  return user;
}

/** Ends the platform session on the server too, as far as it can be reached. */
export async function staffSignOut(): Promise<void> {
  const held = tokens;
  if (held !== null) {
    try {
      await platformClient().POST('/v1/platform/auth/sign-out', { body: { everywhere: false } });
    } catch {
      // Signed out here whatever the server said: the tokens are dropped below.
    }
  }
  forgetPlatformSession();
}

/** Drops the platform session from memory, without telling the server. */
export function forgetPlatformSession(): void {
  tokens = null;
  user = null;
  changed();
}

async function ensureToken(): Promise<string | null> {
  if (tokens === null) {
    return null;
  }
  if (Date.now() < new Date(tokens.accessTokenExpiresAt).getTime() - REFRESH_MARGIN_MS) {
    return tokens.accessToken;
  }
  refreshing ??= refresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

async function refresh(): Promise<string | null> {
  const held = tokens;
  if (held === null) {
    return null;
  }
  try {
    const { data } = await bareClient().POST('/v1/platform/auth/refresh', {
      body: { refreshToken: held.refreshToken },
    });
    tokens = data!;
    return tokens.accessToken;
  } catch {
    // Revoked, reused, past the session's limit, or the account was disabled:
    // none is worth retrying. Staff sign in again.
    forgetPlatformSession();
    return null;
  }
}

let client: Integr8Client | undefined;

/** The API client the staff screens use. Its own instance, its own latch. */
export function platformClient(): Integr8Client {
  client ??= createClient({
    baseUrl: API_BASE_URL,
    clientApp: 'desktop',
    clientVersion: APP_VERSION,
    getAccessToken: () => ensureToken(),
    onUnauthorised: async () => {
      if (tokens !== null) {
        // Expire the access token so the next call refreshes it.
        tokens = { ...tokens, accessTokenExpiresAt: new Date(0).toISOString() };
      }
      return ensureToken();
    },
    onClientTooOld: (info) => {
      reportClientTooOld(info, COMPANY_SLUG);
    },
  });
  return client;
}

// ---------------------------------------------------------------------------
// Working inside a company
// ---------------------------------------------------------------------------

/** The company staff are working inside, so the banner can lead back to it. */
export interface InsideCompany {
  tenantId: string;
  grantId: string;
}

let inside: InsideCompany | null = null;

export function insideCompany(): InsideCompany | null {
  return inside;
}

/**
 * Opens a company: as the company itself (its owner's role, staff's own id)
 * by default, or as one of its people for a support case (the owner's
 * decision D3). Either way a reason of ten characters or more is written to
 * both audit logs before the grant exists.
 *
 * The company session takes over the desktop session's tokens, as a company
 * person's would; the platform session stays in memory alongside it, so
 * **Back to the dashboard** needs no second sign-in.
 */
export async function openCompany(input: {
  tenantId: string;
  reason: string;
  targetUserId?: string | undefined;
}): Promise<void> {
  const { data } = await platformClient().POST('/v1/platform/companies/{tenantId}/impersonate', {
    params: { path: { tenantId: input.tenantId } },
    body: {
      reason: input.reason,
      ...(input.targetUserId === undefined ? {} : { targetUserId: input.targetUserId }),
    },
  });
  await session().adoptTokens(data!.tokens);
  inside = { tenantId: input.tenantId, grantId: data!.grantId };
  changed();
}

/**
 * Ends the grant and the company session, and keeps the platform session.
 * Returns the company left, for the dashboard to open its page.
 */
export async function leaveCompany(): Promise<string | null> {
  const left = inside;
  inside = null;
  // The company session first, while its grant still lets it sign out; then
  // the grant itself, on the platform session.
  await session().signOut();
  if (left !== null && tokens !== null) {
    try {
      await platformClient().POST('/v1/platform/companies/{tenantId}/impersonate/{grantId}/end', {
        params: { path: { tenantId: left.tenantId, grantId: left.grantId } },
      });
    } catch {
      // It lapses on its own within the hour.
    }
  }
  changed();
  return left?.tenantId ?? null;
}

// The company frame finds its way back here through the bridge, without
// importing this module (a company's build never loads it).
registerStaffBridge({
  home: () => (tokens === null ? null : '/platform'),
  insideCompany: () => inside !== null,
  leaveCompany: async () => {
    const tenantId = await leaveCompany();
    return tenantId === null ? '/platform' : `/platform/companies/${tenantId}`;
  },
});
