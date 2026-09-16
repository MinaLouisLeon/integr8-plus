import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The billing provider, behind an interface (P17).
 *
 * Stripe is what this will use, and nothing above this file knows that. The
 * plan's note is the reason: a market that needs a regional provider must be a
 * new adapter rather than a rewrite of the entitlement layer. So the vocabulary
 * here is ours — a checkout, a portal, a subscription that changed — and each
 * adapter translates.
 *
 * The same shape as the push sender and the geocoder: an interface, a real
 * implementation, and a recording fake that the tests and development use.
 */

export interface CheckoutRequest {
  tenantId: string;
  tenantName: string;
  /** Who is paying, so the provider can send them receipts. */
  email: string;
  /** The provider's id for the price being bought. */
  priceId: string;
  /** How many seats to bill for. */
  quantity: number;
  successUrl: string;
  cancelUrl: string;
  /** An existing customer, when this company has paid before. */
  customerId?: string | undefined;
}

export interface PortalRequest {
  customerId: string;
  returnUrl: string;
}

export interface HostedSession {
  /** Where to send the browser. */
  url: string;
  id: string;
}

/**
 * What a webhook turned out to say, in our words.
 *
 * Deliberately small. Everything a provider reports that this system does not
 * act on becomes `kind: 'ignored'` — recorded, because the record is what makes
 * an argument with a provider winnable, and then dropped.
 */
export type BillingEventKind =
  | {
      kind: 'subscription_changed';
      customerId: string;
      subscriptionId: string;
      status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
      priceId: string | null;
      interval: 'month' | 'year' | null;
      quantity: number | null;
      currentPeriodStart: Date | null;
      currentPeriodEnd: Date | null;
      cancelAtPeriodEnd: boolean;
    }
  | { kind: 'payment_failed'; customerId: string; subscriptionId: string | null }
  | { kind: 'payment_succeeded'; customerId: string; subscriptionId: string | null }
  | {
      kind: 'checkout_completed';
      customerId: string;
      subscriptionId: string | null;
      /** The company this checkout was started for, carried through by us. */
      tenantId: string | null;
    }
  | { kind: 'ignored' };

export interface ParsedWebhook {
  /** The provider's own id for this delivery. What makes it idempotent. */
  id: string;
  /** The provider's type string, kept verbatim for the record. */
  type: string;
  event: BillingEventKind;
  payload: Record<string, unknown>;
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export interface BillingProvider {
  readonly provider: string;

  /** A hosted page where somebody subscribes. */
  createCheckout(request: CheckoutRequest): Promise<HostedSession>;

  /** A hosted page where somebody updates a card, reads invoices, or cancels. */
  createPortal(request: PortalRequest): Promise<HostedSession>;

  /**
   * Verifies a delivery and says what it means.
   *
   * Takes the raw bytes rather than a parsed body: a signature covers what was
   * sent, and re-serialising JSON changes it.
   */
  parseWebhook(rawBody: string, signature: string | undefined): ParsedWebhook;

  /** Changes how many seats a subscription is billed for, prorated. */
  setQuantity(subscriptionId: string, quantity: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

/**
 * Billing with no provider behind it.
 *
 * What development and the tests use, and what a deployment without provider
 * keys falls back to — so the whole of the rest of this phase (entitlements,
 * dunning, read-only) is exercised without an account anywhere. Production
 * refuses to start on it; see `assertProductionReady`.
 *
 * Its checkout URL goes nowhere on purpose. A fake that pretended to take a
 * payment would be a fake somebody eventually believed.
 */
export class RecordingBillingProvider implements BillingProvider {
  readonly provider = 'recording';

  readonly checkouts: CheckoutRequest[] = [];
  readonly portals: PortalRequest[] = [];
  readonly quantities: { subscriptionId: string; quantity: number }[] = [];

  createCheckout(request: CheckoutRequest): Promise<HostedSession> {
    this.checkouts.push(request);
    const id = `cs_test_${String(this.checkouts.length)}`;
    return Promise.resolve({ id, url: `https://billing.invalid/checkout/${id}` });
  }

  createPortal(request: PortalRequest): Promise<HostedSession> {
    this.portals.push(request);
    const id = `ps_test_${String(this.portals.length)}`;
    return Promise.resolve({ id, url: `https://billing.invalid/portal/${id}` });
  }

  /**
   * Treats the body as an already-translated event, so a test can post one
   * without pretending to be Stripe. The signature is ignored, which is
   * exactly why production refuses this provider.
   */
  parseWebhook(rawBody: string, signature: string | undefined): ParsedWebhook {
    void signature;
    const body = JSON.parse(rawBody) as {
      id?: string;
      type?: string;
      event?: BillingEventKind;
    };

    return {
      id: body.id ?? 'evt_test',
      type: body.type ?? 'test.event',
      event: body.event ?? { kind: 'ignored' },
      payload: JSON.parse(rawBody) as Record<string, unknown>,
    };
  }

  setQuantity(subscriptionId: string, quantity: number): Promise<void> {
    this.quantities.push({ subscriptionId, quantity });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const STRIPE_API = 'https://api.stripe.com/v1';

/** How far apart the signature's timestamp and now may be. Stripe's own default. */
export const STRIPE_TOLERANCE_SECONDS = 300;

export interface StripeOptions {
  secretKey: string;
  webhookSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Stripe, over its REST API rather than its SDK.
 *
 * The SDK is good and this deliberately does without it: the surface used here
 * is three endpoints and one signature check, and a dependency that sits in the
 * payment path is a dependency to audit on every release. The signature check
 * is the part worth owning outright, and it is the one part of Stripe that can
 * be tested without an account — which it is.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly provider = 'stripe';

  readonly #options: StripeOptions;

  constructor(options: StripeOptions) {
    this.#options = options;
  }

  async createCheckout(request: CheckoutRequest): Promise<HostedSession> {
    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': request.priceId,
      'line_items[0][quantity]': String(request.quantity),
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      // Carried back on the completed event, so a webhook can find the company
      // without trusting anything the browser sent.
      'metadata[tenant_id]': request.tenantId,
      'subscription_data[metadata][tenant_id]': request.tenantId,
      client_reference_id: request.tenantId,
    };
    if (request.customerId === undefined) {
      form.customer_email = request.email;
    } else {
      form.customer = request.customerId;
    }

    const session = await this.#post<{ id: string; url: string | null }>(
      '/checkout/sessions',
      form,
    );
    if (session.url === null) {
      throw new Error('Stripe returned a checkout session with no URL.');
    }
    return { id: session.id, url: session.url };
  }

  async createPortal(request: PortalRequest): Promise<HostedSession> {
    const session = await this.#post<{ id: string; url: string }>('/billing_portal/sessions', {
      customer: request.customerId,
      return_url: request.returnUrl,
    });
    return { id: session.id, url: session.url };
  }

  async setQuantity(subscriptionId: string, quantity: number): Promise<void> {
    // Read the subscription to find the item to change: Stripe bills a
    // quantity per item, not per subscription.
    const subscription = await this.#get<{ items: { data: { id: string }[] } }>(
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    const item = subscription.items.data[0];
    if (item === undefined) {
      throw new Error(`Stripe subscription ${subscriptionId} has no items to change.`);
    }

    await this.#post(`/subscription_items/${encodeURIComponent(item.id)}`, {
      quantity: String(quantity),
      // Bill the difference now rather than at the end of the period, which is
      // what somebody adding a seat mid-month expects to happen.
      proration_behavior: 'create_prorations',
    });
  }

  parseWebhook(rawBody: string, signature: string | undefined): ParsedWebhook {
    verifyStripeSignature({
      rawBody,
      header: signature,
      secret: this.#options.webhookSecret,
      now: this.#options.now?.() ?? new Date(),
    });

    const body = JSON.parse(rawBody) as StripeEvent;
    return {
      id: body.id,
      type: body.type,
      event: translate(body),
      payload: body as unknown as Record<string, unknown>,
    };
  }

  async #post<T>(path: string, form: Record<string, string>): Promise<T> {
    const response = await (this.#options.fetch ?? fetch)(`${STRIPE_API}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#options.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    return this.#read<T>(response);
  }

  async #get<T>(path: string): Promise<T> {
    const response = await (this.#options.fetch ?? fetch)(`${STRIPE_API}${path}`, {
      headers: { authorization: `Bearer ${this.#options.secretKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    return this.#read<T>(response);
  }

  async #read<T>(response: Response): Promise<T> {
    const body = (await response.json()) as T & { error?: { message?: string } };
    if (!response.ok) {
      // Stripe's message is written for a developer and says which field was
      // wrong, which is worth keeping in our logs. It never reaches a caller.
      throw new Error(
        `Stripe answered ${String(response.status)}: ${body.error?.message ?? 'no detail'}`,
      );
    }
    return body;
  }
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/**
 * Checks a `Stripe-Signature` header.
 *
 * The header is `t=<unix seconds>,v1=<hex>,v1=<hex>`, and the signed payload is
 * `<t>.<raw body>` under HMAC-SHA256 with the endpoint's secret. Two details
 * matter and both are attacks rather than formalities:
 *
 * - **the timestamp**, checked against a tolerance, so a delivery captured off
 *   the wire cannot be replayed a week later;
 * - **constant-time comparison**, so the check does not leak the expected
 *   signature a byte at a time.
 *
 * More than one `v1` may be present during a secret rotation, and any of them
 * matching is a pass.
 */
export function verifyStripeSignature(input: {
  rawBody: string;
  header: string | undefined;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): void {
  if (input.header === undefined || input.header === '') {
    throw new WebhookSignatureError('No signature header.');
  }

  let timestamp: string | undefined;
  const candidates: string[] = [];
  for (const part of input.header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined) {
      timestamp = value;
    } else if (key === 'v1' && value !== undefined) {
      candidates.push(value);
    }
  }

  if (timestamp === undefined || candidates.length === 0) {
    throw new WebhookSignatureError('Signature header is malformed.');
  }

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new WebhookSignatureError('Signature timestamp is not a number.');
  }

  const tolerance = input.toleranceSeconds ?? STRIPE_TOLERANCE_SECONDS;
  const age = Math.abs(input.now.getTime() / 1000 - seconds);
  if (age > tolerance) {
    throw new WebhookSignatureError('Signature timestamp is outside the tolerance.');
  }

  const expected = createHmac('sha256', input.secret)
    .update(`${timestamp}.${input.rawBody}`, 'utf8')
    .digest('hex');

  const matched = candidates.some((candidate) => {
    // `timingSafeEqual` throws on a length mismatch, which is itself a length
    // oracle — but the expected length is fixed and public, so a wrong length
    // is simply wrong.
    if (candidate.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
  });

  if (!matched) {
    throw new WebhookSignatureError('Signature does not match.');
  }
}

// ---------------------------------------------------------------------------
// Translating Stripe into our words
// ---------------------------------------------------------------------------

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

function translate(event: StripeEvent): BillingEventKind {
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      return {
        kind: 'checkout_completed',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: text(object, 'subscription'),
        tenantId: text(object, 'client_reference_id'),
      };
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const item = ((object.items as { data?: Record<string, unknown>[] } | undefined)?.data ??
        [])[0];
      const price = item?.price as { id?: string; recurring?: { interval?: string } } | undefined;
      const interval = price?.recurring?.interval;

      return {
        kind: 'subscription_changed',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: text(object, 'id') ?? '',
        // A deletion at Stripe is a cancellation here whatever its status says.
        status:
          event.type === 'customer.subscription.deleted'
            ? 'canceled'
            : mapStatus(text(object, 'status')),
        priceId: price?.id ?? null,
        interval: interval === 'month' || interval === 'year' ? interval : null,
        quantity: typeof item?.quantity === 'number' ? item.quantity : null,
        currentPeriodStart: seconds(object.current_period_start),
        currentPeriodEnd: seconds(object.current_period_end),
        cancelAtPeriodEnd: object.cancel_at_period_end === true,
      };
    }

    case 'invoice.payment_failed': {
      return {
        kind: 'payment_failed',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: text(object, 'subscription'),
      };
    }

    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      return {
        kind: 'payment_succeeded',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: text(object, 'subscription'),
      };
    }

    default:
      return { kind: 'ignored' };
  }
}

/**
 * Stripe's subscription statuses, onto ours.
 *
 * `incomplete_expired` and `unpaid` both mean nobody is paying and nobody is
 * going to, so both land on `canceled`. `paused` is treated as past due
 * rather than active, because the one thing that must not happen is a company
 * keeping full access while nothing is being collected.
 */
function mapStatus(
  status: string | null,
): 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete' {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'paused':
      return 'past_due';
    case 'incomplete':
      return 'incomplete';
    default:
      return 'canceled';
  }
}

function text(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function seconds(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}
