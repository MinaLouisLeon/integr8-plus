import { getPlatformDataSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { billableSeats, entitlementsFor, usageFor } from '../../billing/entitlements.js';
import { ApiError, conflict, notFound } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { applyWebhook } from '../../billing/webhook.js';
import { isoOrNull } from './schemas.js';

/**
 * Paying, and seeing what you pay for (P17).
 *
 * Two of these are the only writes a read-only company may still make, which
 * is the point of read-only: a company that has not paid must be able to pay.
 * The webhook is public and verified by signature — see `billing/provider.ts`.
 */

const subscriptionSchema = z.object({
  plan: z.string(),
  status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'incomplete']),
  interval: z.enum(['month', 'year']).nullable(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  trialEndsAt: z.iso.datetime().nullable(),
  /** Set once a payment has failed; the account goes read-only at `graceEndsAt`. */
  pastDueSince: z.iso.datetime().nullable(),
  graceEndsAt: z.iso.datetime().nullable(),
  /** Whether writes are refused right now, and why. */
  readOnly: z.boolean(),
  readOnlyReason: z.string().nullable(),
  entitlements: z.object({
    seats: z.number().int().nullable(),
    storageBytes: z.number().int().nullable(),
    submissionsPerMonth: z.number().int().nullable(),
  }),
  usage: z.object({
    seatsUsed: z.number().int(),
    submissionsThisMonth: z.number().int(),
  }),
});

export const getSubscriptionRoute = defineRoute({
  method: 'get',
  path: '/v1/billing/subscription',
  operationId: 'getSubscription',
  summary: 'What this company is paying for, and what it is allowed',
  description:
    'The plan, where the subscription stands, and the limits with the usage against them — the same numbers the API enforces, so a screen can warn before a refusal rather than explain one afterwards.',
  tags: ['billing'],
  security: 'authenticated',
  permission: 'billing.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The subscription.', schema: subscriptionSchema },
  },
  handler: async (_input, context) => {
    const tenantId = context.principal.tenantId;
    const platform = getPlatformDataSource();

    const [subscription, tenant] = await Promise.all([
      withTenant(tenantId, (tx) => tx.subscription.find()),
      platform.tenants.findById(tenantId),
    ]);

    const plan = subscription?.plan ?? 'trial';
    const [entitlements, usage] = await Promise.all([entitlementsFor(plan), usageFor(tenantId)]);

    return {
      status: 200,
      body: {
        plan,
        status: subscription?.status ?? 'trialing',
        interval: subscription?.interval ?? null,
        currentPeriodEnd: isoOrNull(subscription?.currentPeriodEnd ?? null),
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        trialEndsAt: isoOrNull(subscription?.trialEndsAt ?? null),
        pastDueSince: isoOrNull(subscription?.pastDueSince ?? null),
        graceEndsAt: isoOrNull(subscription?.graceEndsAt ?? null),
        readOnly: tenant?.readOnlySince != null,
        readOnlyReason: tenant?.readOnlyReason ?? null,
        entitlements: {
          seats: entitlements.seats,
          storageBytes: entitlements.storageBytes,
          submissionsPerMonth: entitlements.submissionsPerMonth,
        },
        usage,
      },
    };
  },
});

export const startCheckoutRoute = defineRoute({
  method: 'post',
  path: '/v1/billing/checkout',
  operationId: 'startCheckout',
  summary: 'Begin paying for a plan',
  description:
    "Returns a link to the provider's hosted page. Card details never touch this API — the browser goes to the provider and comes back, and the subscription becomes real when the provider's webhook says so, not when the browser returns.",
  tags: ['billing'],
  security: 'authenticated',
  permission: 'billing.manage',
  // The one write a company that has not paid must still be able to make.
  allowedWhenReadOnly: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    plan: z.enum(['starter', 'standard', 'enterprise']),
    interval: z.enum(['month', 'year']).default('month'),
  }),
  responses: {
    200: {
      description: 'Where to send the browser.',
      schema: z.object({ url: z.string(), provider: z.string() }),
    },
    409: { description: 'This plan has no price configured (`plan_not_purchasable`).' },
  },
  handler: async ({ body }, context) => {
    const tenantId = context.principal.tenantId;
    const platform = getPlatformDataSource();

    const [tenant, allowance, subscription, member] = await Promise.all([
      platform.tenants.findById(tenantId),
      platform.metering.allowanceFor(body.plan),
      platform.billing.find(tenantId),
      // The provider sends receipts to whoever is paying, so it needs their
      // address rather than their id.
      withTenant(tenantId, (tx) => tx.tenantUsers.findByUserId(context.principal.userId)),
    ]);

    if (tenant === undefined) {
      throw notFound('No such company');
    }

    const priceId =
      body.interval === 'year' ? allowance?.providerPriceYearly : allowance?.providerPriceMonthly;
    if (priceId == null || priceId === '') {
      // A plan nobody has attached a price to cannot be bought. Better to say
      // so than to send somebody to a checkout that fails at the provider.
      throw conflict(
        'plan_not_purchasable',
        `The ${body.plan} plan has no ${body.interval}ly price configured. Please contact support.`,
      );
    }

    const returnUrl = context.config.BILLING_RETURN_URL ?? context.config.WEB_APP_URL;
    if (returnUrl === undefined) {
      throw new ApiError(
        503,
        'billing_not_configured',
        'Billing is not configured on this deployment.',
      );
    }

    const session = await context.services.billing.createCheckout({
      tenantId,
      tenantName: tenant.name,
      email: member?.email ?? '',
      priceId,
      quantity: await billableSeats(tenantId),
      successUrl: `${returnUrl}/billing?checkout=done`,
      cancelUrl: `${returnUrl}/billing?checkout=cancelled`,
      ...(subscription?.providerCustomerId == null
        ? {}
        : { customerId: subscription.providerCustomerId }),
    });

    return {
      status: 200,
      body: { url: session.url, provider: context.services.billing.provider },
    };
  },
});

export const openPortalRoute = defineRoute({
  method: 'post',
  path: '/v1/billing/portal',
  operationId: 'openBillingPortal',
  summary: 'Open the provider’s billing portal',
  description:
    'Where a card is updated, invoices are read and a subscription is cancelled. All of it is the provider’s hosted page, so this API never holds a card number or an invoice.',
  tags: ['billing'],
  security: 'authenticated',
  permission: 'billing.manage',
  // The other write read-only allows: fixing the card is how a company stops
  // being read-only.
  allowedWhenReadOnly: true,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Where to send the browser.',
      schema: z.object({ url: z.string(), provider: z.string() }),
    },
    409: { description: 'This company has never paid, so there is no portal yet.' },
  },
  handler: async (_input, context) => {
    const tenantId = context.principal.tenantId;
    const subscription = await getPlatformDataSource().billing.find(tenantId);

    const customerId = subscription?.providerCustomerId;
    if (customerId == null || customerId === '') {
      throw conflict(
        'no_billing_account',
        'This company has not subscribed yet, so there is nothing to manage. Start a subscription first.',
      );
    }

    const returnUrl = context.config.BILLING_RETURN_URL ?? context.config.WEB_APP_URL;
    const session = await context.services.billing.createPortal({
      customerId,
      returnUrl: `${returnUrl ?? ''}/billing`,
    });

    return {
      status: 200,
      body: { url: session.url, provider: context.services.billing.provider },
    };
  },
});

/**
 * Where the provider tells us what happened.
 *
 * Public, because the caller is somebody else's server with no token of ours,
 * and authorised by its signature instead. Three things make that safe:
 *
 * - the **raw bytes** are verified, not a re-serialised copy of them;
 * - the **timestamp** is checked, so a delivery captured off the wire cannot
 *   be replayed later;
 * - the **event id** is stored under a unique constraint, so the provider's
 *   retries — which are normal, not exceptional — do nothing the second time.
 *
 * It answers 200 to anything it has verified, including an event it does not
 * act on. A provider that receives an error retries for days, and retrying
 * will not make us understand an event we have no handler for.
 */
export const billingWebhookRoute = defineRoute({
  method: 'post',
  path: '/v1/billing/webhook',
  operationId: 'billingWebhook',
  summary: 'What the billing provider says happened',
  description:
    "Verified by signature over the exact bytes sent, and deduplicated on the provider's own event id. Not for clients: it is called by the provider.",
  tags: ['billing'],
  security: 'public',
  rawBody: true,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Accepted, whether or not it was acted on.',
      schema: z.object({ received: z.boolean(), duplicate: z.boolean(), handled: z.boolean() }),
    },
    400: { description: 'The signature did not verify.' },
  },
  handler: async (_input, context) => {
    const raw = context.rawBody ?? '';
    const signature = context.signatureHeader;

    let parsed;
    try {
      parsed = context.services.billing.parseWebhook(raw, signature);
    } catch (error) {
      // Deliberately terse, and deliberately not 401: the caller is not
      // authenticating as anybody, the payload simply did not verify. The
      // detail goes to our logs, never to whoever sent it.
      context.logger.warn('Billing webhook refused', {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw new ApiError(400, 'invalid_signature', 'The signature did not verify.');
    }

    const outcome = await applyWebhook({
      parsed,
      provider: context.services.billing,
      config: context.config,
      logger: context.logger,
    });

    return {
      status: 200,
      body: { received: true, duplicate: outcome.duplicate, handled: outcome.handled },
    };
  },
});

export const billingRoutes = [
  getSubscriptionRoute,
  startCheckoutRoute,
  openPortalRoute,
  billingWebhookRoute,
];
