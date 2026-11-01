import { describe, expect, it } from 'vitest';
import {
  assertProductionReady,
  clientUpdateUrl,
  databaseProblems,
  DEVELOPMENT_UPDATE_URL,
  hrKeySettings,
  loadApiConfig,
  startupWarnings,
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
  HR_DATA_KEY: Buffer.alloc(32, 1).toString('base64'),
} as const;

/** The database settings a production API or worker is given (0058). */
const PRODUCTION_DATABASE = {
  DATABASE_URL_PLATFORM:
    'postgres://integr8_platform:a-generated-password-of-32-chars@postgres:5432/integr8',
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

describe('the Cloudflare analytics token', () => {
  // Nightly metering compares the ledger with Cloudflare's bill through it.
  // Missing, every night's check says "unavailable": worth a warning, never a
  // refusal to start.
  it('is warned about in production with R2, without stopping the start', () => {
    const config = loadApiConfig({
      ...PRODUCTION_BASE,
      API_CORS_ORIGINS: 'https://app.example.com',
    });
    expect(startupWarnings(config).join(' ')).toMatch(/CLOUDFLARE_API_TOKEN is not set/u);
    expect(() => {
      assertProductionReady(config, PRODUCTION_DATABASE);
    }).not.toThrow();
  });

  it('is not warned about once set, or outside production, or a blank line', () => {
    expect(
      startupWarnings(
        loadApiConfig({
          ...PRODUCTION_BASE,
          API_CORS_ORIGINS: 'https://app.example.com',
          CLOUDFLARE_API_TOKEN: 'cf-token',
        }),
      ),
    ).toEqual([]);
    expect(startupWarnings(loadApiConfig({ ...PRODUCTION_BASE, APP_ENV: 'staging' }), {})).toEqual(
      [],
    );
    expect(loadApiConfig({ CLOUDFLARE_API_TOKEN: '' }).CLOUDFLARE_API_TOKEN).toBeUndefined();
  });
});

describe('the HR data key', () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

  it('is required in production', () => {
    expect(() => {
      assertProductionReady(
        loadApiConfig({
          ...PRODUCTION_BASE,
          API_CORS_ORIGINS: 'https://app.example.com',
          HR_DATA_KEY: '',
        }),
        PRODUCTION_DATABASE,
      );
    }).toThrow(/HR_DATA_KEY is not set/u);
  });

  it('reads older keys, comma-separated, and refuses them without a current one', () => {
    const config = loadApiConfig({
      HR_DATA_KEY: key(2),
      HR_DATA_KEYS_PREVIOUS: ` ${key(1)}, ${key(3)} ,`,
    });
    expect(hrKeySettings(config)).toEqual({ current: key(2), previous: [key(1), key(3)] });
    expect(hrKeySettings(loadApiConfig({}))).toBeUndefined();
    expect(loadApiConfig({ HR_DATA_KEYS_PREVIOUS: '' }).HR_DATA_KEYS_PREVIOUS).toBeUndefined();
    expect(() => loadApiConfig({ HR_DATA_KEYS_PREVIOUS: key(1) })).toThrow(
      /HR_DATA_KEYS_PREVIOUS is set but HR_DATA_KEY is not/u,
    );
    expect(() => loadApiConfig({ HR_DATA_KEY: key(2), HR_DATA_KEYS_PREVIOUS: 'short' })).toThrow(
      /HR_DATA_KEYS_PREVIOUS/u,
    );
  });
});

describe('where an app too old to be served is sent', () => {
  it("is the web app's download page unless set", () => {
    expect(clientUpdateUrl(loadApiConfig({ WEB_APP_URL: 'https://app.integr8-media.com/' }))).toBe(
      'https://app.integr8-media.com/download',
    );
    expect(
      clientUpdateUrl(
        loadApiConfig({
          WEB_APP_URL: 'https://app.integr8-media.com',
          API_UPDATE_URL: 'https://downloads.integr8-media.com',
        }),
      ),
    ).toBe('https://downloads.integr8-media.com');
    // A blank line in the env file is the same as no line.
    expect(
      clientUpdateUrl(
        loadApiConfig({ WEB_APP_URL: 'https://app.integr8-media.com', API_UPDATE_URL: ' ' }),
      ),
    ).toBe('https://app.integr8-media.com/download');
    expect(clientUpdateUrl(loadApiConfig({}))).toBe(DEVELOPMENT_UPDATE_URL);
  });

  const ready = (overrides: Record<string, string | undefined>) => () =>
    assertProductionReady(
      loadApiConfig({
        ...PRODUCTION_BASE,
        API_CORS_ORIGINS: 'https://app.example.com',
        ...overrides,
      }),
      PRODUCTION_DATABASE,
    );

  it('is refused in production when it is the old example address', () => {
    expect(ready({ API_UPDATE_URL: 'https://integr8.example/download' })).toThrow(
      /API_UPDATE_URL names an example address/u,
    );
    expect(ready({ API_UPDATE_URL: 'https://app.your-domain.example/download' })).toThrow(
      /API_UPDATE_URL names an example address/u,
    );
    expect(ready({ API_UPDATE_URL: undefined })).not.toThrow();
    expect(ready({ API_UPDATE_URL: 'https://app.example.com/download' })).not.toThrow();
  });

  it('is refused in production when there is nothing to derive it from', () => {
    expect(ready({ WEB_APP_URL: undefined })).toThrow(
      /API_UPDATE_URL and WEB_APP_URL are both unset/u,
    );
  });
});

describe('example values from deploy/.env.example', () => {
  const config = loadApiConfig({ ...PRODUCTION_BASE, API_CORS_ORIGINS: 'https://app.example.com' });

  it('stop a production start: change-me, example addresses, short database passwords', () => {
    const start = (env: NodeJS.ProcessEnv) => () => {
      assertProductionReady(config, { ...PRODUCTION_DATABASE, ...env });
    };
    expect(
      start({
        DATABASE_URL: 'postgres://integr8_app:change-me-app-password@postgres:5432/integr8',
      }),
    ).toThrow(/DATABASE_URL still holds the "change-me" example value/u);
    expect(start({ PLATFORM_SECRET_KEY: 'change-me' })).toThrow(/PLATFORM_SECRET_KEY still holds/u);
    expect(start({ AUTH_ISSUER: 'https://api.your-domain.example' })).toThrow(
      /AUTH_ISSUER names an example address/u,
    );
    expect(
      start({ DATABASE_URL_PLATFORM: 'postgres://integr8_platform:password1@postgres:5432/x' }),
    ).toThrow(/The password in DATABASE_URL_PLATFORM is shorter than 16 characters/u);
    expect(
      loadApiConfig({ ...PRODUCTION_BASE, WEB_APP_URL: 'https://app.your-domain.example' }),
    ).toBeDefined();
    expect(() => {
      assertProductionReady(
        loadApiConfig({
          ...PRODUCTION_BASE,
          WEB_APP_URL: 'https://app.your-domain.example',
          API_CORS_ORIGINS: 'https://app.your-domain.example',
        }),
        PRODUCTION_DATABASE,
      );
    }).toThrow(/WEB_APP_URL names an example address/u);
  });

  it('never print the secret itself', () => {
    let message = '';
    try {
      assertProductionReady(config, {
        DATABASE_URL_PLATFORM: 'postgres://integr8_platform:hunter2@postgres:5432/integr8',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL_PLATFORM is shorter/u);
    expect(message).not.toContain('hunter2');
  });

  it('are warned about in staging, which still starts', () => {
    const staging = loadApiConfig({ APP_ENV: 'staging', WEB_APP_URL: 'https://app.example.com' });
    const warnings = startupWarnings(staging, {
      POSTGRES_PASSWORD: 'change-me-owner-password',
      AUTH_ISSUER: 'https://api.integr8.local',
    });
    expect(warnings).toEqual([
      expect.stringMatching(/^Production would refuse to start: AUTH_ISSUER names an example/u),
      expect.stringMatching(/^Production would refuse to start: POSTGRES_PASSWORD still holds/u),
    ]);
    expect(() => {
      assertProductionReady(staging, { POSTGRES_PASSWORD: 'change-me-owner-password' });
    }).not.toThrow();
  });
});
