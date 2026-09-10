import { createClient, type Integr8Client } from '@integr8/api-client';
import { describeApp, optionalEnv } from '@integr8/core';
import { buildAppInfo } from './app-info.js';

/**
 * Placeholder process for the mobile application.
 *
 * P05 replaces this with the Expo application shell. What it does now is build the generated
 * API client, which is P04's first exit criterion: the client is generated from
 * `openapi.json`, so an endpoint that changed shape stops this app compiling
 * rather than failing on a customer's device.
 *
 * Tokens are deliberately absent. Where they live is a per-client decision —
 * the OS keychain, SecureStore, an httpOnly cookie — and P05 makes it against
 * the `TokenStore` contract in `@integr8/core`. Returning null here means every
 * call is unauthenticated, which is the correct behaviour for an app with
 * nobody signed in.
 */
const info = buildAppInfo();

export const api: Integr8Client = createClient({
  baseUrl: optionalEnv('API_BASE_URL', 'http://localhost:3000'),
  clientApp: 'mobile',
  clientVersion: info.version,
  getAccessToken: () => null,
  onClientTooOld: ({ minimum, message }) => {
    console.error(`This build is older than the minimum supported (${minimum}). ${message}`);
  },
});

console.log(describeApp(info));
console.log('P05 replaces this with the Expo application shell.');
