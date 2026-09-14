import {
  type IdentityProvider,
  ImpersonationService,
  InvitationService,
  loadAuthConfig,
  loadSigningKey,
  loadVerificationKeys,
  SessionService,
  SignInService,
  SupabaseIdentityProvider,
  TokenService,
} from '@integr8/auth';
import { configureDatabase, loadDatabaseConfig } from '@integr8/db';
import { type ApiConfig, publicUrl } from './config.js';
import { LocalDiskStorage } from './media/local-disk.js';
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
  identity: IdentityProvider;
  /** Where uploaded files live. Local disk until P09 adds R2. */
  media: MediaStorage;
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
    invitations: new InvitationService({ identity, sessions, config: authConfig }),
    impersonation: new ImpersonationService({ sessions, config: authConfig }),
    media: new LocalDiskStorage({
      directory: options.config.MEDIA_LOCAL_DIR,
      secret: options.config.MEDIA_URL_SECRET,
      publicUrl: publicUrl(options.config),
    }),
  };
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
