import {
  type IdentityProvider,
  ImpersonationService,
  InvitationService,
  loadAuthConfig,
  loadSigningKey,
  loadVerificationKeys,
  type PasswordPolicy,
  PasswordService,
  PlatformSessionService,
  SessionService,
  SignInService,
  SupabaseIdentityProvider,
  TokenService,
} from '@integr8/auth';
import { configureDatabase, getPlatformDataSource, loadDatabaseConfig } from '@integr8/db';
import {
  type ApiConfig,
  corsOrigins,
  publicUrl,
  r2Settings,
  supabaseAuthSettings,
} from './config.js';
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
import type { AiServices } from './ai/chat.js';
import { HelpLibrary } from './ai/help/library.js';
import { PriceTable } from './ai/pricing.js';
import { buildAiProvider } from './ai/providers/index.js';
import { INSIGHT_TOOLS } from './ai/tools/insights.js';
import { buildPdfPrinter, type PdfPrinter } from './documents/printer.js';
import { buildEtaServices, type EtaServices } from './eta/services.js';
import {
  type AppBuildTrigger,
  GitHubAppBuildTrigger,
  RecordingAppBuildTrigger,
} from './platform/app-builds.js';

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
  /** Change password (P36): proof, the policy, and signing out every other device. */
  passwords: PasswordService;
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
  /**
   * The assistant (docs/ai; ADR-0001): the model provider `AI_PROVIDER` names,
   * the price table it is costed with, and the help library it answers from.
   * Built whether or not AI_ENABLED is on: off is a policy answer, not a
   * missing service.
   */
  ai: AiServices;
  /**
   * Prints PDF documents (docs/documents; ADR-0001). Used by the worker,
   * never in a request. Chromium starts on the first document, not here.
   */
  pdf: PdfPrinter;
  /**
   * The Egyptian Tax Authority (docs/e-invoicing; ADR-0014): a transport per
   * environment and the token cache. Each company's own credentials are
   * opened per request; there are no deployment-wide taxpayer credentials.
   */
  eta: EtaServices;
  /**
   * Starts one company's app build on GitHub when the dashboard asks for one.
   * A recording stand-in unless APP_BUILDS is `github`.
   */
  appBuilds: AppBuildTrigger;
}

export interface BuildServicesOptions {
  config: ApiConfig;
  env?: NodeJS.ProcessEnv;
  /**
   * Replaces the identity provider.
   *
   * Used by the integration suite, which runs no Auth container and does not
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
    passwords: new PasswordService({
      identity,
      sessions,
      config: authConfig,
      // Across companies, which only the platform connection can see.
      companiesWithSessions: (userId) =>
        getPlatformDataSource().tenants.withLiveSessionsFor(userId),
    }),
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
    ai: {
      provider: buildAiProvider(options.config),
      prices: new PriceTable(options.config),
      help: new HelpLibrary(options.config.API_RELEASE),
      tools: INSIGHT_TOOLS,
    },
    pdf: buildPdfPrinter(options.config),
    eta: buildEtaServices(options.config),
    appBuilds: buildAppBuildTrigger(options.config),
  };
}

/** Like email: `github` with a missing token or repository refuses to start (see `appBuildProblems`). */
export function buildAppBuildTrigger(config: ApiConfig): AppBuildTrigger {
  if (config.APP_BUILDS !== 'github') {
    return new RecordingAppBuildTrigger();
  }
  const token = config.GITHUB_BUILD_TOKEN;
  const repository = config.GITHUB_BUILD_REPOSITORY;
  if (token === undefined || repository === undefined) {
    throw new Error(
      'APP_BUILDS is github but GITHUB_BUILD_TOKEN or GITHUB_BUILD_REPOSITORY is not set.',
    );
  }
  return new GitHubAppBuildTrigger({ token, repository, ref: config.GITHUB_BUILD_REF });
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
 * Builds the identity provider for the self-hosted Supabase Auth container, or
 * refuses to.
 *
 * There is no silent fallback to a fake. A service that quietly accepts any
 * password when a variable is missing is a service that will do so in
 * production on the day somebody mistypes a secret name.
 */
function buildIdentityProvider(config: ApiConfig, env: NodeJS.ProcessEnv): IdentityProvider {
  const auth = supabaseAuthSettings(env);
  if ('problems' in auth) {
    throw new Error(
      [
        'Sign-in cannot be served:',
        ...auth.problems.map((problem) => `  ${problem}`),
        '',
        `APP_ENV is "${config.APP_ENV}".`,
        'See docs/auth/self-hosted-auth.md.',
      ].join('\n'),
    );
  }

  return new SupabaseIdentityProvider(auth.settings);
}
