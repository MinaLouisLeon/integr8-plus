import { createClient, type Integr8Client } from '@integr8/api-client';

/**
 * The API client for the public site's browser code (P42).
 *
 * Nobody signs in on the public site any more: the office works in the
 * company's desktop app and staff in the staff app. So this client carries no
 * token; it reaches the public routes only (a quote link, a shared document,
 * an invitation, the plans, the downloads).
 */

let client: Integr8Client | undefined;

export function apiClient(): Integr8Client {
  client ??= createClient({
    baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000',
    clientApp: 'web',
    clientVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0',
    getAccessToken: () => Promise.resolve(null),
    onUnauthorised: () => Promise.resolve(null),
    onClientTooOld: ({ message }) => {
      // A page is updated by reloading it, so there is nothing to offer here.
      console.warn(message);
    },
  });
  return client;
}
