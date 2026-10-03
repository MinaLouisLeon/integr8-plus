import { getPlatformDataSource, type TenantPlan } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../http/logger.js';
import { forgetTenantStatus } from '../http/suspension.js';
import { forgetAllowances } from '../media/quota.js';
import type { BillingProvider, ParsedWebhook } from './provider.js';

/**
 * What a webhook does once it has been verified (P17).
 *
 * Separate from the route so it can be tested without HTTP, and so the two
 * things that make it correct are visible together:
 *
 * - **it is idempotent by storage, not by care.** Every delivery is inserted
 *   against the provider's own event id, and the unique constraint decides.
 *   A duplicate loses the insert and returns, having done nothing. Stripe
 *   retries for days, so this is the normal path rather than the unlucky one.
 * - **it never trusts the body for identity.** The company comes from the
 *   customer id we stored when the checkout was created, or from the reference
 *   we put on the checkout ourselves — on the checkout event directly, and on
 *   the subscription and invoice events through the metadata Stripe copies
 *   from our checkout, because those routinely arrive first. A payload that
 *   names a company we do not have is recorded and dropped.
 */

export interface WebhookOutcome {
  /** Seen before. With `handled` false, nothing was done this time. */
  duplicate: boolean;
  handled: boolean;
  tenantId: string | null;
  type: string;
}

export async function applyWebhook(input: {
  parsed: ParsedWebhook;
  provider: BillingProvider;
  config: ApiConfig;
  logger: Logger;
  now?: Date;
}): Promise<WebhookOutcome> {
  const { parsed, provider } = input;
  const billing = getPlatformDataSource().billing;
  const now = input.now ?? new Date();

  const tenantId = await findTenant(provider.provider, parsed);

  const { event, duplicate } = await billing.recordEvent({
    provider: provider.provider,
    providerEventId: parsed.id,
    type: parsed.type,
    tenantId,
    payload: parsed.payload,
  });

  if (duplicate && event.processedAt !== null && event.error === null) {
    // The delivery has been seen and applied. Saying so is the whole point: the
    // provider retries, and a retry must not charge, cancel or unlock anything
    // twice.
    input.logger.info('Billing event already applied', {
      provider: provider.provider,
      eventId: parsed.id,
      type: parsed.type,
    });
    return { duplicate: true, handled: false, tenantId: event.tenantId, type: parsed.type };
  }

  if (duplicate) {
    // Seen, but never applied: the handler threw, or the process died between
    // recording the row and acting on it. The row was inserted before the
    // handler ran, so without this the provider's retry — the one thing that
    // can still apply a payment — would be answered "already seen" and the
    // company would stay unpaid for ever.
    input.logger.warn('Billing event recorded earlier but not applied; applying on retry', {
      provider: provider.provider,
      eventId: parsed.id,
      type: parsed.type,
      previousError: event.error,
    });
  }

  if (tenantId === null) {
    // Usually a test delivery, or a customer created against the same provider
    // account by another environment. Kept, because the record is what makes
    // the question answerable later.
    await billing.markEventProcessed(
      event.id,
      'No company matches this customer or the reference our checkout attached.',
    );
    return { duplicate, handled: false, tenantId: null, type: parsed.type };
  }

  try {
    await handle({ tenantId, parsed, provider, config: input.config, now });
    await billing.markEventProcessed(event.id);
    return { duplicate, handled: true, tenantId, type: parsed.type };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await billing.markEventProcessed(event.id, message);
    throw error;
  }
}

/**
 * Which company a delivery is about.
 *
 * Two ways, in order of trust: the customer id we recorded when this company
 * first paid, and the reference our own checkout call attached — carried on the
 * checkout event as `client_reference_id`, and on the subscription and invoice
 * events as the metadata Stripe copies from the checkout onto them. Nothing
 * reads a company id straight out of an arbitrary payload: the reference is
 * accepted only when no customer is on file, only when it names a company we
 * have, and only when that company has no *other* customer on file.
 *
 * The second way matters more than it looks. Stripe does not order deliveries,
 * and for a first purchase `customer.subscription.created` and `invoice.paid`
 * usually arrive before `checkout.session.completed` — the one event that used
 * to be able to name the company. Without the reference on those, the plan and
 * status they carry were dropped with a 200, the company stayed on `trial`, and
 * the trial's end made a paying customer read-only.
 */
async function findTenant(provider: string, parsed: ParsedWebhook): Promise<string | null> {
  const billing = getPlatformDataSource().billing;
  const event = parsed.event;

  if (event.kind === 'ignored') {
    return null;
  }

  const byCustomer = await billing.findByCustomer(provider, event.customerId);
  if (byCustomer !== undefined) {
    // A stored mapping always wins. Whatever the payload's reference says, a
    // customer we have on file belongs to the company we filed it under.
    return byCustomer.tenantId;
  }

  const reference = event.kind === 'checkout_completed' ? event.tenantId : event.tenantHint;
  if (reference === null || !UUID.test(reference)) {
    // Not shaped like one of our ids, so not something our checkout wrote.
    // Checked before the query, because a malformed id would make Postgres
    // throw, the route answer 500, and the provider retry a delivery that can
    // never succeed.
    return null;
  }

  const subscription = await billing.find(reference);
  if (subscription === undefined) {
    return null;
  }

  if (
    subscription.providerCustomerId !== null &&
    subscription.providerCustomerId !== event.customerId
  ) {
    // The company named already pays as somebody else. Our checkout reuses a
    // company's customer id, so a second customer with our reference on it is
    // not something we produced; recorded and dropped rather than letting a
    // reference re-point a company's billing.
    return null;
  }

  return subscription.tenantId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

async function handle(input: {
  tenantId: string;
  parsed: ParsedWebhook;
  provider: BillingProvider;
  config: ApiConfig;
  now: Date;
}): Promise<void> {
  const { tenantId, now } = input;
  const platform = getPlatformDataSource();
  const billing = platform.billing;
  const event = input.parsed.event;

  switch (event.kind) {
    case 'checkout_completed': {
      const existing = await billing.find(tenantId);

      // The ids are what this event is for, and are always taken. The status
      // and plan are taken only when nothing has been heard about this
      // subscription yet: when the subscription's own events arrived first —
      // the usual order — they have already said more than a checkout can, and
      // a checkout that completed an hour ago must not undo a `past_due` that
      // arrived since. When they have not arrived, the row would otherwise sit
      // on `trial` with a paid subscription's ids, which is the state the trial
      // sweep later turns read-only.
      const unheard =
        event.subscriptionId !== null && existing?.providerSubscriptionId !== event.subscriptionId;
      const plan = unheard ? await planForPrice(event.priceId) : undefined;
      const status = unheard ? event.status : null;

      await billing.update(tenantId, {
        providerCustomerId: event.customerId,
        ...(event.subscriptionId === null ? {} : { providerSubscriptionId: event.subscriptionId }),
        ...(plan === undefined ? {} : { plan }),
        ...(status === null ? {} : { status }),
        ...(status === 'active' ? { pastDueSince: null, graceEndsAt: null, remindersSent: 0 } : {}),
      });

      if (plan !== undefined) {
        await platform.tenants.setPlan(tenantId, { plan });
      }
      if (status === 'active') {
        await platform.tenants.setReadOnly(tenantId, null);
      }
      if (plan !== undefined || status !== null) {
        forgetTenantStatus(tenantId);
        forgetAllowances();
      }
      return;
    }

    case 'subscription_changed': {
      const plan = await planForPrice(event.priceId);

      await billing.update(tenantId, {
        providerCustomerId: event.customerId,
        providerSubscriptionId: event.subscriptionId,
        status: event.status,
        ...(plan === undefined ? {} : { plan }),
        interval: event.interval,
        currentPeriodStart: event.currentPeriodStart,
        currentPeriodEnd: event.currentPeriodEnd,
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        // Paying clears the dunning clock, whatever it said before.
        ...(event.status === 'active'
          ? { pastDueSince: null, graceEndsAt: null, remindersSent: 0 }
          : {}),
      });

      // The plan on the company row is what the door-check caches and what
      // every entitlement reads, so it follows the subscription rather than
      // being set by hand somewhere else.
      if (plan !== undefined) {
        await platform.tenants.setPlan(tenantId, { plan });
      }

      if (event.status === 'active') {
        await platform.tenants.setReadOnly(tenantId, null);
      }
      if (event.status === 'canceled') {
        await platform.tenants.setReadOnly(
          tenantId,
          'This subscription has been cancelled. Your data is here and you can export it; paying again restores everything.',
        );
      }

      forgetTenantStatus(tenantId);
      forgetAllowances();
      return;
    }

    case 'payment_failed': {
      const existing = await billing.find(tenantId);
      // The clock starts on the first failure and is not restarted by the
      // retries that follow, or a card failing weekly would never run out.
      if (existing?.pastDueSince != null) {
        return;
      }

      await billing.update(tenantId, {
        status: 'past_due',
        pastDueSince: now,
        graceEndsAt: new Date(
          now.getTime() + input.config.BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
        ),
        remindersSent: 0,
      });
      return;
    }

    case 'payment_succeeded': {
      await billing.update(tenantId, {
        status: 'active',
        pastDueSince: null,
        graceEndsAt: null,
        remindersSent: 0,
      });
      await platform.tenants.setReadOnly(tenantId, null);
      forgetTenantStatus(tenantId);
      return;
    }

    default:
      return;
  }
}

/**
 * Which plan a provider's price belongs to.
 *
 * Looked up rather than carried in the payload: a price id in a webhook is the
 * provider's, and the mapping from it to one of our plans is ours to decide.
 * An unknown price leaves the plan alone — better a subscription on the plan
 * it had than one silently moved to a plan nobody sold.
 */
async function planForPrice(priceId: string | null): Promise<TenantPlan | undefined> {
  if (priceId === null) {
    return undefined;
  }

  const allowances = await getPlatformDataSource().metering.allowances();
  return allowances.find(
    (allowance) =>
      allowance.providerPriceMonthly === priceId || allowance.providerPriceYearly === priceId,
  )?.plan;
}
