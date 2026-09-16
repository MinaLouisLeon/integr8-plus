import { z } from 'zod';
import { defineRoute, noSchema } from '../../http/routes.js';
import { recordStep, resendSignup, startSignup, verifySignup } from '../../signup/service.js';

/**
 * Making your own company (P18).
 *
 * Public, because the caller has no account — that is what they are here to
 * get. Three properties hold the whole design up:
 *
 * - **Nothing is created until the address is proved.** `POST /v1/signup`
 *   writes a request and sends an email. The company, the bucket, the trial and
 *   the identity all happen at `verify`, and only then.
 * - **Every answer is the same whether or not the address is known.** An
 *   endpoint that says "that address already has a company" enumerates your
 *   customers one guess at a time. The person who owns the address finds out in
 *   the message they receive.
 * - **Every step is recorded**, because "the funnel is instrumented and
 *   drop-off is visible per step" is an exit criterion, and the steps worth
 *   seeing happen before any company exists to attribute them to.
 */

const TAGS = ['signup'];

const acceptedSchema = z.object({
  /**
   * Always true, and deliberately uninformative.
   *
   * It means "we have taken this and if there is something to send, it is
   * sent" — not "an account was created", which the caller must not be able to
   * learn.
   */
  accepted: z.boolean(),
});

export const startSignupRoute = defineRoute({
  method: 'post',
  path: '/v1/signup',
  operationId: 'startSignup',
  summary: 'Ask for a company',
  description:
    'Sends a link to prove the address. Nothing is created until that link is followed: no company, no storage, no trial. Answers the same way whether or not the address already has an account.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.string().min(3).max(320),
    companyName: z.string().trim().min(1).max(120),
  }),
  responses: {
    202: { description: 'Taken. Check the inbox.', schema: acceptedSchema },
    503: { description: 'Signing up is not configured on this deployment.' },
  },
  handler: async ({ body }, context) => {
    await startSignup(
      {
        email: body.email,
        companyName: body.companyName,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      },
      {
        config: context.config,
        logger: context.logger,
        email: context.services.email,
        media: context.services.media,
        billingProvider: context.services.billing.provider,
      },
    );

    return { status: 202, body: { accepted: true } };
  },
});

export const verifySignupRoute = defineRoute({
  method: 'post',
  path: '/v1/signup/verify',
  operationId: 'verifySignup',
  summary: 'Prove the address, and get the company',
  description:
    'Creates the account, the company, its job types, its storage and its trial — in that order, so a failure part-way leaves nothing orphaned. The caller signs in normally afterwards.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    token: z.string().min(1).max(512),
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(1).max(200),
  }),
  responses: {
    200: {
      description: 'The company exists.',
      schema: z.object({ tenantId: z.uuid(), email: z.string() }),
    },
    422: { description: 'The link is spent, expired or unknown (`invalid_signup_token`).' },
  },
  handler: async ({ body }, context) => {
    const result = await verifySignup(
      { token: body.token, displayName: body.displayName, password: body.password },
      {
        config: context.config,
        logger: context.logger,
        email: context.services.email,
        media: context.services.media,
        billingProvider: context.services.billing.provider,
        identity: context.services.identity,
      },
    );

    // No tokens here either, for the same reason the invitation route withholds
    // them: the link this came from may be sitting in a mailbox. The address is
    // returned so the page can sign in with the password just chosen.
    return { status: 200, body: { tenantId: result.tenantId, email: result.email } };
  },
});

export const resendSignupRoute = defineRoute({
  method: 'post',
  path: '/v1/signup/resend',
  operationId: 'resendSignupVerification',
  summary: 'Send the verification link again',
  description:
    'Rotates the link, so the previous one stops working. Answers the same way whether or not there was anything to send.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({ email: z.string().min(3).max(320) }),
  responses: {
    202: { description: 'Taken.', schema: acceptedSchema },
  },
  handler: async ({ body }, context) => {
    await resendSignup(body.email, {
      config: context.config,
      logger: context.logger,
      email: context.services.email,
      media: context.services.media,
      billingProvider: context.services.billing.provider,
    });

    return { status: 202, body: { accepted: true } };
  },
});

/**
 * The steps that happen in a browser, before the API is otherwise involved.
 *
 * Landing, pricing, the signup form being opened. Without these the funnel
 * starts at "submitted the form", which measures conversion after the hard part
 * and shows none of the drop-off worth seeing.
 *
 * Carries no identity and no address — a step name and, at most, which plan was
 * being looked at. The table it writes to answers "how many gave up here",
 * never "who".
 */
export const recordFunnelStepRoute = defineRoute({
  method: 'post',
  path: '/v1/signup/step',
  operationId: 'recordSignupStep',
  summary: 'Record a step of the signup funnel',
  description:
    'Called by the public pages. Anonymous by construction: a step name and an optional plan, nothing that identifies a person.',
  tags: TAGS,
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: z.object({
    step: z.enum(['landing.viewed', 'pricing.viewed', 'features.viewed', 'signup.opened']),
    plan: z.enum(['trial', 'starter', 'standard', 'enterprise']).optional(),
  }),
  responses: { 202: { description: 'Recorded, or quietly not.', schema: acceptedSchema } },
  handler: async ({ body }, context) => {
    await recordStep(context.logger, body.step, {
      ...(body.plan === undefined ? {} : { metadata: { plan: body.plan } }),
    });
    return { status: 202, body: { accepted: true } };
  },
});

export const signupRoutes = [
  startSignupRoute,
  verifySignupRoute,
  resendSignupRoute,
  recordFunnelStepRoute,
];
