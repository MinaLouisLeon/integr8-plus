import {
  type IdentityProvider,
  ImpersonationService,
  InvitationService,
  loadAuthConfig,
  loadSigningKey,
  loadVerificationKeys,
  type PasswordPolicy,
  PlatformSessionService,
  SessionService,
  SignInService,
  SupabaseIdentityProvider,
  TokenService,
} from '@integr8/auth';
import { configureDatabase, loadDatabaseConfig } from '@integr8/db';
import { type ApiConfig, corsOrigins, publicUrl, r2Settings } from './config.js';
import { LocalDiskStorage } from './media/local-disk.js';
import { FakeGeocoder, type Geocoder, MapboxGeocoder } from './geo/geocoder.js';
import {
  type BillingProvider,
  RecordingBillingProvider,
  StripeBillingProvider,
} from './billing/provider.js';
import { assertSeatAvailable } from './billing/entitlements.js';
import { planFor } from './http/suspension.js';
import { ExpoPushSender, type PushSender, RecordingPushSender } from './push/sender.js';
import { type EmailSender, RecordingEmailSender, ResendEmailSender } from './email/sender.js';
import { R2Storage } from './media/r2.js';
import type { MediaStorage } from './media/storage.js';

/**
 * The composition root.
 *
 * Everything the API needs is built here, once, and passed down. No container,
 * no decorators, no reflection: the dependency graph is a function you can read
 * from top to bottom, and a service that is hard to construct is visible as a
 * complicated line here rather than as a runtime resolution failure.
 *
 * Module boundaries come from imports and from what this function chooses to
 * expose, which is the same discipline a container would enforce with more
 * machinery.
 */

export interface Services {
  tokens: TokenService;
  sessions: SessionService;
  signIn: SignInService;
  invitations: InvitationService;
  impersonation: ImpersonationService;
  /** Super admins signed in to the dashboard (P15). No company; see the platform routes. */
  platform: PlatformSessionService;
  identity: IdentityProvider;
  /**
   * What a password has to be, for the one place outside `@integr8/auth` that
   * takes one: self-serve signup (P18). The same policy invitation acceptance
   * applies, so a company's owner is held to what its engineers are.
   */
  passwordPolicy: PasswordPolicy;
  /** Company buckets: R2, or local disk in development. Reach one through `getStorage`. */
  media: MediaStorage;
  /** Site addresses to coordinates. Used by the worker, never in a request. */
  geocoder: Geocoder;
  /** Push notifications to engineers' phones. Used by the worker, never in a request. */
  push: PushSender;
  /** Who takes the money (P17). Stripe in production, a recording fake elsewhere. */
  billing: BillingProvider;
  /**
   * Who carries the mail (P18).
   *
   * The dependency several finished features were waiting on: an invitation
   * that nothing delivered, and dunning reminders that could only be shown
   * in-app.
   */
  email: EmailSender;
}

export interface BuildServicesOptions {
  config: ApiConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the identity provider.
   *
   * Used by the integration suite, which has no Supabase project and does not
   * need one: everything worth testing in this service happens after a
   * credential has been accepted.
   */
  identity?: IdentityProvider;
}

export async function buildServices(options: BuildServicesOptions): Promise<Services> {
  const env = options.env ?? process.env;

  configureDatabase(loadDatabaseConfig(env));

  const authConfig = loadAuthConfig(env);
  const tokens = new TokenService({
    config: authConfig,
    signingKey: await loadSigningKey(authConfig),
    verificationKeys: await loadVerificationKeys(authConfig),
  });

  const identity = options.identity ?? buildIdentityProvider(options.config, env);
  const sessions = new SessionService({ tokens, config: authConfig });

  return {
    tokens,
    sessions,
    identity,
    signIn: new SignInService({ identity, sessions, config: authConfig }),
    invitations: new InvitationService({
      identity,
      sessions,
      config: authConfig,
      // The plan's seat limit, enforced at the moment a seat is taken (P17).
      // `@integr8/auth` has no idea what a plan is; this is where the two meet.
      seatCheck: async (tenantId) =>
        assertSeatAvailable({ tenantId, plan: await planFor(tenantId) }),
    }),
    impersonation: new ImpersonationService({ sessions, config: authConfig }),
    passwordPolicy: { minLength: authConfig.AUTH_MIN_PASSWORD_LENGTH },
    platform: new PlatformSessionService({ tokens, config: authConfig }),
    media: buildMediaStorage(options.config),
    geocoder: buildGeocoder(options.config),
    push: buildPushSender(options.config),
    billing: buildBillingProvider(options.config),
    email: buildEmailSender(options.config),
  };
}

/**
 * The billing provider.
 *
 * Unlike the geocoder, a missing key is not a silent fallback to the fake: a
 * deployment that meant to charge cards and quietly did not is worse than one
 * that refuses to start. `loadApiConfig` throws before this is reached, and
 * this repeats the check because the two could drift.
 */
export function buildBillingProvider(config: ApiConfig): BillingProvider {
  if (config.BILLING_PROVIDER !== 'stripe') {
    return new RecordingBillingProvider();
  }

  const secretKey = config.STRIPE_SECRET_KEY;
  const webhookSecret = config.STRIPE_WEBHOOK_SECRET;
  if (secretKey === undefined || webhookSecret === undefined) {
    throw new Error(
      'BILLING_PROVIDER is stripe but STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET is not set.',
    );
  }

  return new StripeBillingProvider({ secretKey, webhookSecret });
}

/**
 * The email sender.
 *
 * Like billing and unlike the geocoder, a missing key is not a silent fallback
 * to the fake. Mail that quietly goes nowhere is worse than mail that fails
 * loudly: nobody notices until a customer says they never got their invitation.
 */
export function buildEmailSender(config: ApiConfig): EmailSender {
  if (config.EMAIL_SENDER !== 'resend') {
    return new RecordingEmailSender();
  }

  const apiKey = config.RESEND_API_KEY;
  const from = config.EMAIL_FROM;
  if (apiKey === undefined || from === undefined) {
    throw new Error('EMAIL_SENDER is resend but RESEND_API_KEY or EMAIL_FROM is not set.');
  }

  return new ResendEmailSender({ apiKey, from });
}

export function buildPushSender(config: ApiConfig): PushSender {
  return config.PUSH_SENDER === 'expo'
    ? new ExpoPushSender({ accessToken: config.EXPO_ACCESS_TOKEN })
    : new RecordingPushSender();
}

export function buildGeocoder(config: ApiConfig): Geocoder {
  if (config.GEOCODER === 'mapbox') {
    return new MapboxGeocoder({ accessToken: config.MAPBOX_ACCESS_TOKEN ?? '' });
  }
  return new FakeGeocoder();
}

export function buildMediaStorage(config: ApiConfig): MediaStorage {
  if (config.MEDIA_STORAGE === 'r2') {
    const r2 = r2Settings(config);
    if (!('settings' in r2)) {
      throw new Error(`MEDIA_STORAGE is r2 but ${r2.missing.join(', ')} not set.`);
    }
    return new R2Storage({ ...r2.settings, corsOrigins: corsOrigins(config) });
  }
  return new LocalDiskStorage({
    directory: config.MEDIA_LOCAL_DIR,
    secret: config.MEDIA_URL_SECRET,
    publicUrl: publicUrl(config),
  });
}

/**
 * Builds the Supabase identity provider, or refuses to.
 *
 * There is no silent fallback to a fake. A service that quietly accepts any
 * password when a variable is missing is a service that will do so in
 * production on the day somebody mistypes a secret name.
 */
function buildIdentityProvider(config: ApiConfig, env: NodeJS.ProcessEnv): IdentityProvider {
  const url = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (url === undefined || url === '' || serviceRoleKey === undefined || serviceRoleKey === '') {
    throw new Error(
      [
        'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to serve sign-in.',
        '',
        `APP_ENV is "${config.APP_ENV}".`,
        'See docs/auth/README.md and docs/database/runbook-supabase-setup.md.',
      ].join('\n'),
    );
  }

  return new SupabaseIdentityProvider({ url, serviceRoleKey });
}
