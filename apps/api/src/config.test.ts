import { describe, expect, it } from 'vitest';
import {
  assertProductionReady,
  databaseProblems,
  loadApiConfig,
  supabaseAuthSettings,
  webOriginMissingFromCors,
} from './config.js';

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
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
  EMAIL_SENDER: 'resend',
  RESEND_API_KEY: 're_x',
  EMAIL_FROM: 'Integr8 <hello@example.com>',
  WEB_APP_URL: 'https://app.example.com',
} as const;

/** The database settings a production API or worker is given (0058). */
const PRODUCTION_DATABASE = {
  DATABASE_URL_PLATFORM: 'postgres://integr8_platform:x@postgres:5432/integr8',
};

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
        PRODUCTION_DATABASE,
      ),
    ).toThrow(/API_CORS_ORIGINS does not include https:\/\/app\.example\.com/u);

    expect(() =>
      assertProductionReady(
        loadApiConfig({
          ...PRODUCTION_BASE,
          API_CORS_ORIGINS: 'https://app.example.com,tauri://localhost',
        }),
        PRODUCTION_DATABASE,
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

describe('e-invoicing settings', () => {
  // E-invoicing stays off until it has been tested with the tax authority, so a
  // deployment must start without any of its settings, and with the blank lines
  // deploy/.env.example has for them.
  const BLANK_ETA = {
    ETA_CREDENTIALS_KEY: '',
    ETA_ALLOW_PRODUCTION: '',
    ETA_PREPROD_CA_FILE: '',
    ETA_PREPROD_IDENTITY_URL: '',
    ETA_PREPROD_API_URL: '',
    ETA_PRODUCTION_IDENTITY_URL: '',
    ETA_PRODUCTION_API_URL: '',
    ETA_REQUEST_TIMEOUT_MS: '',
    ETA_SIGNING_REQUEST_TTL_SECONDS: '',
    ETA_MAX_STATUS_CHECKS: '',
  };

  it('starts without any of them', () => {
    const config = loadApiConfig({});
    expect(config.ETA_CREDENTIALS_KEY).toBeUndefined();
    expect(config.ETA_ALLOW_PRODUCTION).toBe(false);
  });

  it('reads a blank line as not set', () => {
    const config = loadApiConfig(BLANK_ETA);
    expect(config.ETA_CREDENTIALS_KEY).toBeUndefined();
    expect(config.ETA_ALLOW_PRODUCTION).toBe(false);
    expect(config.ETA_PREPROD_CA_FILE).toBeUndefined();
    expect(config.ETA_PREPROD_API_URL).toBeUndefined();
    expect(config.ETA_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(config.ETA_SIGNING_REQUEST_TTL_SECONDS).toBe(900);
    expect(config.ETA_MAX_STATUS_CHECKS).toBe(12);
  });

  it('still refuses a value that is set and wrong', () => {
    expect(() => loadApiConfig({ ETA_CREDENTIALS_KEY: 'too-short' })).toThrow(
      /ETA_CREDENTIALS_KEY/u,
    );
    expect(() => loadApiConfig({ ETA_ALLOW_PRODUCTION: 'yes' })).toThrow(/ETA_ALLOW_PRODUCTION/u);
    const key = Buffer.alloc(32, 7).toString('base64');
    expect(loadApiConfig({ ETA_CREDENTIALS_KEY: key }).ETA_CREDENTIALS_KEY).toBe(key);
  });
});

describe('other optional keys left blank in the env file', () => {
  // deploy/.env.example has an empty line for each; an operator who leaves one
  // empty must get the feature switched off, not a server that will not start.
  it('reads a blank HR_DATA_KEY and BUILD_TOKEN as not set', () => {
    const config = loadApiConfig({ HR_DATA_KEY: '', BUILD_TOKEN: '' });
    expect(config.HR_DATA_KEY).toBeUndefined();
    expect(config.BUILD_TOKEN).toBeUndefined();
  });

  it('still refuses them when set and wrong', () => {
    expect(() => loadApiConfig({ HR_DATA_KEY: 'too-short' })).toThrow(/HR_DATA_KEY/u);
    expect(() => loadApiConfig({ BUILD_TOKEN: 'short' })).toThrow(/BUILD_TOKEN/u);
  });
});

describe('the self-hosted Auth settings (P36)', () => {
  it('takes the container address and the service role key as given', () => {
    expect(
      supabaseAuthSettings({
        SUPABASE_AUTH_URL: 'http://auth:9999',
        SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key',
      }),
    ).toEqual({ settings: { url: 'http://auth:9999', serviceRoleKey: 'eyJ.key' } });
  });

  it('refuses the old SUPABASE_URL, naming the new variable', () => {
    const result = supabaseAuthSettings({
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_AUTH_URL: 'http://auth:9999',
      SUPABASE_SERVICE_ROLE_KEY: 'eyJ.key',
    });
    expect(result).toHaveProperty('problems');
    expect(JSON.stringify(result)).toContain('SUPABASE_AUTH_URL');
    expect(JSON.stringify(result)).toContain('SUPABASE_URL is no longer read');
  });

  it('names what is missing or malformed', () => {
    const missing = supabaseAuthSettings({});
    expect(JSON.stringify(missing)).toContain('SUPABASE_AUTH_URL is not set');
    expect(JSON.stringify(missing)).toContain('SUPABASE_SERVICE_ROLE_KEY is not set');

    const malformed = supabaseAuthSettings({
      SUPABASE_AUTH_URL: 'auth 9999',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    });
    expect(JSON.stringify(malformed)).toContain('not an address');
  });
});

describe('the database connections production is given', () => {
  // The API and the worker run as integr8_platform; the owner's password stays
  // with the migrate service.
  it('accepts the platform role alone', () => {
    expect(databaseProblems(PRODUCTION_DATABASE)).toEqual([]);
  });

  it("refuses the owner's connection, and a missing platform one", () => {
    const problems = databaseProblems({
      DATABASE_URL_ADMIN: 'postgres://postgres:x@postgres:5432/integr8',
    }).join(' ');
    expect(problems).toMatch(/DATABASE_URL_ADMIN is set/u);
    expect(problems).toMatch(/DATABASE_URL_PLATFORM is not set/u);
  });

  it('stops a production start over it', () => {
    const config = loadApiConfig({
      ...PRODUCTION_BASE,
      API_CORS_ORIGINS: 'https://app.example.com',
    });
    expect(() =>
      assertProductionReady(config, {
        ...PRODUCTION_DATABASE,
        DATABASE_URL_ADMIN: 'postgres://postgres:x@postgres:5432/integr8',
      }),
    ).toThrow(/DATABASE_URL_ADMIN is set/u);
  });
});

describe('the billing provider in production', () => {
  const ready = (overrides: Record<string, string | undefined>) => () =>
    assertProductionReady(
      loadApiConfig({
        ...PRODUCTION_BASE,
        API_CORS_ORIGINS: 'https://app.example.com',
        ...overrides,
      }),
      PRODUCTION_DATABASE,
    );

  it('starts with none and no Stripe keys: Integr8 invoices every company', () => {
    expect(
      ready({
        BILLING_PROVIDER: 'none',
        STRIPE_SECRET_KEY: undefined,
        STRIPE_WEBHOOK_SECRET: undefined,
      }),
    ).not.toThrow();
  });

  it('refuses Stripe test keys, which would mark companies paid with no money moving', () => {
    expect(ready({ STRIPE_SECRET_KEY: 'sk_test_abc' })).toThrow(/test-mode key/u);
    expect(ready({ STRIPE_SECRET_KEY: 'rk_test_abc' })).toThrow(/test-mode key/u);
    expect(ready({ STRIPE_SECRET_KEY: 'pk_live_abc' })).toThrow(/publishable key/u);
    expect(ready({ STRIPE_SECRET_KEY: 'sk_live_abc' })).not.toThrow();
  });

  it('still refuses recording', () => {
    expect(ready({ BILLING_PROVIDER: 'recording' })).toThrow(/BILLING_PROVIDER is recording/u);
  });

  it('lets staging use test keys', () => {
    expect(() =>
      assertProductionReady(
        loadApiConfig({ ...PRODUCTION_BASE, APP_ENV: 'staging', STRIPE_SECRET_KEY: 'sk_test_abc' }),
      ),
    ).not.toThrow();
  });
});
