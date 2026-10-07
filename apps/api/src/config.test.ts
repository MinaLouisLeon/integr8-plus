import { describe, expect, it } from 'vitest';
import { assertProductionReady, loadApiConfig, webOriginMissingFromCors } from './config.js';

/**
 * The deployment mistake this guards against: WEB_APP_URL set to the real
 * address while API_CORS_ORIGINS still names a placeholder, or nothing. Sign-in
 * works regardless, because it goes through the web server; every dashboard
 * screen then fails in the browser with a CORS error and an empty API log.
 */

const PRODUCTION_BASE = {
  APP_ENV: 'production',
  SENTRY_DSN: 'https://x@sentry.example/1',
  API_RELEASE: '1.0.0',
  MEDIA_STORAGE: 'r2',
  CLOUDFLARE_ACCOUNT_ID: 'acc',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  GEOCODER: 'mapbox',
  MAPBOX_ACCESS_TOKEN: 'pk.token',
  PUSH_SENDER: 'expo',
  BILLING_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  EMAIL_SENDER: 'resend',
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'Integr8 <hello@example.com>',
  WEB_APP_URL: 'https://app.example.com',
} as const;

describe("the web app's origin and API_CORS_ORIGINS", () => {
  it('is fine when the origin is listed, however the URL is written', () => {
    const config = loadApiConfig({
      APP_ENV: 'staging',
      WEB_APP_URL: 'https://app.example.com/',
      API_CORS_ORIGINS: ' https://app.example.com/ , tauri://localhost',
    });
    expect(webOriginMissingFromCors(config)).toBeUndefined();
  });

  it('names the gap when the origin is not listed', () => {
    const config = loadApiConfig({
      APP_ENV: 'staging',
      WEB_APP_URL: 'https://app.example.com',
      API_CORS_ORIGINS: 'https://app.your-domain.example,tauri://localhost',
    });
    expect(webOriginMissingFromCors(config)).toMatch(/https:\/\/app\.example\.com/u);
  });

  it('has nothing to say without a WEB_APP_URL', () => {
    expect(webOriginMissingFromCors(loadApiConfig({ APP_ENV: 'staging' }))).toBeUndefined();
  });

  it('refuses to start in production over it, and starts once it is fixed', () => {
    expect(() =>
      assertProductionReady(
        loadApiConfig({ ...PRODUCTION_BASE, API_CORS_ORIGINS: 'https://app.your-domain.example' }),
      ),
    ).toThrow(/API_CORS_ORIGINS does not include https:\/\/app\.example\.com/u);

    expect(() =>
      assertProductionReady(
        loadApiConfig({
          ...PRODUCTION_BASE,
          API_CORS_ORIGINS: 'https://app.example.com,tauri://localhost',
        }),
      ),
    ).not.toThrow();
  });
});

describe('public sign-up', () => {
  // Companies are set up by Integr8 from the dashboard; a deployment has to
  // say so explicitly to let strangers make their own.
  it('is off unless the deployment opens it', () => {
    expect(loadApiConfig({}).PUBLIC_SIGNUP).toBe('off');
    expect(loadApiConfig({ PUBLIC_SIGNUP: 'open' }).PUBLIC_SIGNUP).toBe('open');
    expect(() => loadApiConfig({ PUBLIC_SIGNUP: 'yes' })).toThrow();
  });
});
