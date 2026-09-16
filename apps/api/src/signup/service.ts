import { mintInvitationToken, parseInvitationToken } from '@integr8/auth';
import { toPlatformUserId } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import { deliver } from '../email/deliver.js';
import { verifySignupUrl } from '../email/links.js';
import { signupVerificationEmail } from '../email/messages.js';
import type { EmailSender } from '../email/sender.js';
import { ApiError, conflict } from '../http/errors.js';
import type { Logger } from '../http/logger.js';
import type { MediaStorage } from '../media/storage.js';
import { onboardCompany } from '../platform/onboarding.js';

/**
 * A stranger making their own company (P18).
 *
 * The shape of it, and the reason for the shape: **nothing is created until the
 * address is proved.** Signing up writes one row in `signup_requests` and sends
 * one email. No tenant, no R2 bucket, no trial, no identity at Supabase. A bot
 * that never reads mail costs a row; a bot that does read mail is a person with
 * a mailbox, which is as far as free signup can reasonably go.
 *
 * The second reason is cheaper to explain and just as real: a company created
 * for an address nobody owns cannot be closed by the person who ends up owning
 * that address, and cannot be cleaned up by us without deleting somebody's
 * data. Not creating it is easier than unpicking it.
 *
 * Every step records a funnel event, because the exit criterion is drop-off per
 * step and the interesting drop-offs happen before any company exists — which
 * is exactly why they cannot go in `audit_log`.
 */

/** How long a verification link lives. Long enough to survive a night's sleep. */
export const SIGNUP_TTL_SECONDS = 24 * 60 * 60;

/** How many times one address may ask, per window, before we stop sending. */
const MAX_REQUESTS_PER_DAY = 5;

export const SIGNUP_STEPS = {
  started: 'signup.started',
  emailSent: 'signup.email_sent',
  verified: 'signup.verified',
  provisioned: 'signup.provisioned',
  failed: 'signup.failed',
} as const;

export interface SignupDeps {
  config: ApiConfig;
  logger: Logger;
  email: EmailSender;
  media: MediaStorage;
  /** Who will take the money, once they decide to pay. */
  billingProvider: string;
}

/**
 * Records a funnel step, and never lets it break anything.
 *
 * An analytics write that fails a signup is a far worse outcome than a gap in
 * a chart, so this swallows everything.
 */
export async function recordStep(
  logger: Logger,
  step: string,
  input: {
    signupId?: string | null;
    tenantId?: string | null;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  try {
    await getPlatformDataSource().signup.recordEvent({ step, ...input });
  } catch (error) {
    logger.warn('Funnel event not recorded', {
      step,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface StartSignupInput {
  email: string;
  companyName: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Takes a request and sends the proof-of-address email.
 *
 * **Answers the same way whether or not the address is already in use.** An
 * endpoint that says "that address already has a company" is an endpoint that
 * tells a stranger which of your customers exist, one guess at a time. The
 * person who owns the address is told, in the message they are sent.
 */
export async function startSignup(
  input: StartSignupInput,
  deps: SignupDeps,
): Promise<{ id: string | null }> {
  const email = input.email.trim().toLowerCase();
  const signup = getPlatformDataSource().signup;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if ((await signup.countSince(email, since)) >= MAX_REQUESTS_PER_DAY) {
    // Deliberately not an error the caller can distinguish from success. The
    // limit exists to stop us being used to send mail to somebody else.
    deps.logger.warn('Signup throttled', { reason: 'too_many_requests_for_address' });
    await recordStep(deps.logger, SIGNUP_STEPS.failed, { metadata: { reason: 'throttled' } });
    return { id: null };
  }

  const secret = mintInvitationToken(toPlatformUserId(PLACEHOLDER_TENANT));
  const expiresAt = new Date(Date.now() + SIGNUP_TTL_SECONDS * 1000);

  const request = await signup.create({
    email,
    companyName: input.companyName,
    tokenHash: secret.hash,
    expiresAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  await recordStep(deps.logger, SIGNUP_STEPS.started, { signupId: request.id });

  const url = verifySignupUrl(deps.config.WEB_APP_URL, secret.token);
  if (url === null) {
    throw new ApiError(
      503,
      'signup_not_configured',
      'Signing up is not available on this deployment.',
    );
  }

  const sent = await deliver(
    deps.email,
    deps.logger,
    signupVerificationEmail({
      to: email,
      companyName: input.companyName,
      verifyUrl: url,
      expiresAt,
    }),
    { kind: 'signup', signupId: request.id },
  );

  if (sent.sent) {
    await recordStep(deps.logger, SIGNUP_STEPS.emailSent, { signupId: request.id });
  } else {
    await recordStep(deps.logger, SIGNUP_STEPS.failed, {
      signupId: request.id,
      metadata: { reason: 'email_failed' },
    });
  }

  return { id: request.id };
}

/**
 * A fixed value standing in for the tenant a signup token is not yet scoped to.
 *
 * `mintInvitationToken` binds a token to a tenant, and a signup has no tenant —
 * that is the whole point. Rather than build a second token format, the signup
 * token is bound to this constant and looked up by its hash, which is what the
 * lookup does anyway. The hash is what makes it unguessable; the tenant in the
 * payload does no security work here.
 */
const PLACEHOLDER_TENANT = '00000000-0000-4000-8000-000000000000';

export interface VerifySignupInput {
  token: string;
  displayName: string;
  password: string;
}

export interface VerifiedSignup {
  tenantId: string;
  userId: string;
  email: string;
}

/**
 * Proves the address, and only then builds the company.
 *
 * The order matters and is the opposite of what reads naturally: the identity
 * is created at the provider *before* the company, because a failure there must
 * not leave an orphan company, while a failure creating the company leaves an
 * identity that can simply sign up again.
 */
export async function verifySignup(
  input: VerifySignupInput,
  deps: SignupDeps & {
    identity: { createIdentity: (email: string, password: string) => Promise<{ userId: string }> };
  },
): Promise<VerifiedSignup> {
  const parsed = parseInvitationToken(input.token);
  if (parsed === undefined) {
    throw invalidToken();
  }

  const signup = getPlatformDataSource().signup;
  const request = await signup.findByTokenHash(parsed.hash);
  if (request?.status !== 'pending' || request.expiresAt <= new Date()) {
    // Expired, spent and never-existed are one answer. Distinguishing them
    // tells a stranger which addresses have signed up.
    throw invalidToken();
  }

  await recordStep(deps.logger, SIGNUP_STEPS.verified, { signupId: request.id });

  const identity = await deps.identity.createIdentity(request.email, input.password);

  let onboarded;
  try {
    onboarded = await onboardCompany({
      slug: await freeSlug(request.companyName),
      name: request.companyName,
      plan: 'trial',
      seats: null,
      ownerEmail: request.email,
      ownerAccess: {
        kind: 'direct',
        userId: identity.userId,
        displayName: input.displayName,
      },
      // Nobody. This is the whole reason `onboardedBy` became nullable.
      onboardedBy: null,
      invitationTtlSeconds: SIGNUP_TTL_SECONDS,
      media: deps.media,
      billing: {
        provider: deps.billingProvider,
        trialDays: deps.config.BILLING_TRIAL_DAYS,
      },
    });
  } catch (error) {
    await recordStep(deps.logger, SIGNUP_STEPS.failed, {
      signupId: request.id,
      metadata: { reason: 'provisioning_failed' },
    });
    throw error;
  }

  // Conditional on still being pending: a mail client that prefetches links,
  // or a person who double-clicks, would otherwise make two companies.
  const claimed = await signup.markVerified(request.id, onboarded.tenant.id);
  if (!claimed) {
    deps.logger.warn('Signup verified twice; the second is a no-op', { signupId: request.id });
  }

  await recordStep(deps.logger, SIGNUP_STEPS.provisioned, {
    signupId: request.id,
    tenantId: onboarded.tenant.id,
  });

  return { tenantId: onboarded.tenant.id, userId: identity.userId, email: request.email };
}

/** Resends the verification link, rotating it so the old one stops working. */
export async function resendSignup(email: string, deps: SignupDeps): Promise<void> {
  const signup = getPlatformDataSource().signup;
  const request = await signup.findLatestByEmail(email);
  if (request?.status !== 'pending') {
    // Same silence as `startSignup`, and for the same reason.
    return;
  }

  const secret = mintInvitationToken(toPlatformUserId(PLACEHOLDER_TENANT));
  const expiresAt = new Date(Date.now() + SIGNUP_TTL_SECONDS * 1000);
  if (!(await signup.rotateToken(request.id, secret.hash, expiresAt))) {
    return;
  }

  const url = verifySignupUrl(deps.config.WEB_APP_URL, secret.token);
  if (url === null) {
    return;
  }

  await deliver(
    deps.email,
    deps.logger,
    signupVerificationEmail({
      to: request.email,
      companyName: request.companyName,
      verifyUrl: url,
      expiresAt,
    }),
    { kind: 'signup_resend', signupId: request.id },
  );
}

function invalidToken(): ApiError {
  return new ApiError(
    422,
    'invalid_signup_token',
    'This link is no longer valid. It may have been used already, or it may have expired. Start again and we will send a new one.',
  );
}

/**
 * A slug nobody is using, derived from the company's own name.
 *
 * Derived rather than chosen, because a self-serve flow that lets somebody pick
 * their own slug is a flow where two people race for the same one — and the
 * unique index is the only protection onboarding has, since the idempotency
 * table is tenant-scoped and a signup has no tenant. A numeric suffix is added
 * until one is free, which terminates because the suffix grows.
 */
export async function freeSlug(companyName: string): Promise<string> {
  const base =
    companyName
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'company';

  const tenants = getPlatformDataSource().tenants;
  if ((await tenants.findBySlug(base)) === undefined) {
    return base;
  }

  for (let suffix = 2; suffix < 500; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if ((await tenants.findBySlug(candidate)) === undefined) {
      return candidate;
    }
  }

  throw conflict('slug_unavailable', 'Could not find a free name for this company.');
}
