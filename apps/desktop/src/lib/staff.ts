import { createClient, type Integr8Client } from '@integr8/api-client';
import { APP_VERSION, API_BASE_URL } from './env';
import { session } from './session';

/**
 * Integr8 staff signing in to a company's desktop app.
 *
 * Forms and job types are built by Integr8 for each company, not by the
 * company. So a staff member needs a way into any company's builder that does
 * not involve becoming a member of it — the database refuses that outright —
 * and does not involve knowing anybody's password.
 *
 * This is that way, and it is the dashboard's "act as a company" with a
 * different front: sign in to the platform here, pick the company, give a
 * reason, and the API answers with a session in that company that carries the
 * impersonation claim. From then on it is an ordinary desktop session, and
 * every row it writes is attributed to the staff member behind it.
 *
 * The platform token lives in this module for the few seconds between signing
 * in and opening a company, and is dropped as soon as the company session
 * exists. Nothing platform-level is ever written to the credential store.
 */

export interface StaffUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CompanyChoice {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  members: number;
}

let platformAccessToken: string | null = null;
let client: Integr8Client | undefined;

function platform(): Integr8Client {
  client ??= createClient({
    baseUrl: API_BASE_URL,
    clientApp: 'desktop',
    clientVersion: APP_VERSION,
    getAccessToken: () => Promise.resolve(platformAccessToken),
    // A platform access token lasts five minutes; the whole flow takes far
    // less. A 401 here means it has gone, and the answer is to sign in again
    // rather than to refresh in the background.
    onUnauthorised: () => Promise.resolve(null),
  });
  return client;
}

export async function staffSignIn(input: {
  email: string;
  password: string;
  code: string;
}): Promise<StaffUser> {
  const { data } = await platform().POST('/v1/platform/auth/sign-in', { body: input });
  platformAccessToken = data!.tokens.accessToken;
  return data!.platformUser;
}

export async function listCompanies(search: string): Promise<CompanyChoice[]> {
  const trimmed = search.trim();
  const { data } = await platform().GET('/v1/platform/companies', {
    params: {
      query: { includeCancelled: 'false', ...(trimmed === '' ? {} : { search: trimmed }) },
    },
  });
  return (data?.items ?? []).map((company) => ({
    id: company.id,
    name: company.name,
    slug: company.slug,
    status: company.status,
    plan: company.plan,
    members: company.members,
  }));
}

/**
 * Opens a company as its owner, without naming any of its members.
 *
 * The desktop session takes over the tokens the API minted under the grant.
 * The platform token is then forgotten: the company session is all this app
 * needs, and the fewer places a platform credential exists the better.
 */
export async function openCompany(tenantId: string, reason: string): Promise<void> {
  const { data } = await platform().POST('/v1/platform/companies/{tenantId}/impersonate', {
    params: { path: { tenantId } },
    body: { reason },
  });
  await session().adoptTokens(data!.tokens);
  platformAccessToken = null;
}

/** For a screen that wants to know whether a platform sign-in is still held. */
export function hasPlatformSession(): boolean {
  return platformAccessToken !== null;
}

export function forgetPlatformSession(): void {
  platformAccessToken = null;
}
