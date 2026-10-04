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

export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * One invoice, in our words.
 *
 * Amounts are integer minor units — pence, cents — because that is what every
 * provider sends and a float is how 19.99 becomes 19.989999. The two links are
 * the provider's own hosted pages: this API never holds an invoice, so showing
 * one means sending the browser to where it actually is.
 */
export interface Invoice {
  id: string;
  /** The number printed on it, which is what somebody quotes to their accountant. */
  number: string | null;
  status: InvoiceStatus;
  amountDueCents: number;
  amountPaidCents: number;
  /** Upper-case ISO 4217. */
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  createdAt: Date;
  hostedUrl: string | null;
  pdfUrl: string | null;
}

/** How many invoices a list asks for: two years of monthly billing. */
export const INVOICE_LIST_LIMIT = 24;

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
      tenantHint: string | null;
    }
  | {
      kind: 'payment_failed';
      customerId: string;
      subscriptionId: string | null;
      tenantHint: string | null;
    }
  | {
      kind: 'payment_succeeded';
      customerId: string;
      subscriptionId: string | null;
      tenantHint: string | null;
    }
  | {
      kind: 'checkout_completed';
      customerId: string;
      subscriptionId: string | null;
      /** The company this checkout was started for, carried through by us. */
      tenantId: string | null;
      /**
       * What the checkout says about the subscription it started, when it says
       * anything: the price our own checkout call asked for, and whether the
       * first charge was taken (`active`) or deferred by a trial (`trialing`).
       * Null when the payload does not carry it.
       */
      priceId: string | null;
      status: 'active' | 'trialing' | null;
    }
  | { kind: 'ignored' };

/**
 * The `tenantHint` on the subscription and invoice events is **the company our
 * own checkout named**, read back out of the metadata Stripe copies from the
 * checkout onto the subscription and from the subscription onto its invoices.
 *
 * It exists because Stripe does not order deliveries. For a first purchase,
 * `customer.subscription.created` and `invoice.paid` routinely arrive before
 * `checkout.session.completed`, and until that one has arrived there is no
 * customer id on file to match them by — so they were recorded as "no company
 * matches", answered 200, and never retried, leaving a paying company on its
 * trial for dunning to make read-only. The hint lets the earlier events land.
 *
 * A hint, not an identity: the webhook handler trusts a stored customer
 * mapping over it, and before acting on it checks that the company it names
 * exists and has no other customer.
 */

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

  /**
   * The invoices a customer has been sent, newest first.
   *
   * Read from the provider on every call rather than mirrored into a table:
   * an invoice is the provider's document, it changes there (paid, voided,
   * refunded) without a webhook we act on, and a copy here would be the one
   * that was wrong.
   */
  listInvoices(customerId: string): Promise<Invoice[]>;
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
  /** What this fake has "issued", by customer. Seeded by tests through `issueInvoice`. */
  readonly invoices: (Invoice & { customerId: string })[] = [];

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
      event: withDefaults(body.event ?? { kind: 'ignored' }),
      payload: JSON.parse(rawBody) as Record<string, unknown>,
    };
  }

  setQuantity(subscriptionId: string, quantity: number): Promise<void> {
    this.quantities.push({ subscriptionId, quantity });
    return Promise.resolve();
  }

  /**
   * Pretends to have billed a customer.
   *
   * Deterministic by construction — the number, the id and the dates follow
   * from how many have been issued so far — so a test can assert on exact
   * values and a screenshot of the billing page looks the same twice.
   */
  issueInvoice(customerId: string, overrides: Partial<Invoice> = {}): Invoice {
    const sequence = this.invoices.length + 1;
    // A fixed calendar rather than `Date.now()`: the point of the fake is that
    // nothing about it depends on when it is run.
    const periodEnd = new Date(Date.UTC(2026, sequence, 1));
    const periodStart = new Date(Date.UTC(2026, sequence - 1, 1));
    const invoice: Invoice = {
      id: `in_test_${String(sequence)}`,
      number: `TEST-${String(sequence).padStart(4, '0')}`,
      status: 'paid',
      amountDueCents: 4900,
      amountPaidCents: 4900,
      currency: 'GBP',
      periodStart,
      periodEnd,
      createdAt: periodStart,
      hostedUrl: `https://billing.invalid/invoices/in_test_${String(sequence)}`,
      pdfUrl: `https://billing.invalid/invoices/in_test_${String(sequence)}.pdf`,
      ...overrides,
    };
    this.invoices.push({ ...invoice, customerId });
    return invoice;
  }

  listInvoices(customerId: string): Promise<Invoice[]> {
    return Promise.resolve(
      this.invoices
        .filter((invoice) => invoice.customerId === customerId)
        .map(({ customerId: _owner, ...invoice }) => invoice)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }
}

/**
 * Fills in what a hand-written event may leave out.
 *
 * The fake takes the body as the event, so a test written before the tenant
 * hint existed — or one that has no interest in it — would otherwise hand the
 * handler an object missing a field the type says is there. Absent means null,
 * which is what the Stripe translation produces for a subscription our checkout
 * did not create.
 */
function withDefaults(event: BillingEventKind): BillingEventKind {
  switch (event.kind) {
    case 'subscription_changed':
    case 'payment_failed':
    case 'payment_succeeded':
      return { ...event, tenantHint: event.tenantHint ?? null };
    case 'checkout_completed':
      return {
        ...event,
        tenantId: event.tenantId ?? null,
        priceId: event.priceId ?? null,
        status: event.status ?? null,
      };
    default:
      return event;
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
 * is four endpoints and one signature check, and a dependency that sits in the
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
      // without trusting anything the browser sent. The subscription gets the
      // same metadata, and Stripe copies it onto every invoice — which is what
      // lets a subscription or invoice event that arrives *before* the checkout
      // event find its company (see `translate`).
      'metadata[tenant_id]': request.tenantId,
      'subscription_data[metadata][tenant_id]': request.tenantId,
      client_reference_id: request.tenantId,
      // The price too, so the completed-checkout event alone can put the
      // company on the right plan: the session object in a webhook is not
      // expanded and does not carry its line items.
      'metadata[price_id]': request.priceId,
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

  async listInvoices(customerId: string): Promise<Invoice[]> {
    const query = new URLSearchParams({
      customer: customerId,
      limit: String(INVOICE_LIST_LIMIT),
    });
    const page = await this.#get<{ data: StripeInvoice[] }>(`/invoices?${query.toString()}`);
    return page.data.map(toInvoice);
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
      const paymentStatus = text(object, 'payment_status');
      return {
        kind: 'checkout_completed',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: text(object, 'subscription'),
        // Both were set by our own checkout call: the reference is what the
        // handler has always read, the metadata is the same value by another
        // route in case a later API version drops one of them.
        tenantId: text(object, 'client_reference_id') ?? metadataText(object, 'tenant_id'),
        priceId: metadataText(object, 'price_id'),
        // `paid` means the first charge went through; `no_payment_required` is
        // what a subscription that opens with a trial says. `unpaid` is a
        // checkout that completed without collecting: nothing to assert.
        status:
          paymentStatus === 'paid'
            ? 'active'
            : paymentStatus === 'no_payment_required'
              ? 'trialing'
              : null,
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
        // `subscription_data[metadata][tenant_id]` from our checkout, now on
        // the subscription itself.
        tenantHint: metadataText(object, 'tenant_id'),
      };
    }

    case 'invoice.payment_failed': {
      return {
        kind: 'payment_failed',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: invoiceSubscription(object),
        tenantHint: invoiceTenantHint(object),
      };
    }

    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      return {
        kind: 'payment_succeeded',
        customerId: text(object, 'customer') ?? '',
        subscriptionId: invoiceSubscription(object),
        tenantHint: invoiceTenantHint(object),
      };
    }

    default:
      return { kind: 'ignored' };
  }
}

/**
 * The subscription an invoice bills.
 *
 * `invoice.subscription` on API versions before 2025-03-31, and
 * `invoice.parent.subscription_details.subscription` from then on. Both are
 * read, because the version is a setting on the Stripe account rather than
 * anything this code controls.
 */
function invoiceSubscription(invoice: Record<string, unknown>): string | null {
  return text(invoice, 'subscription') ?? text(subscriptionDetails(invoice), 'subscription');
}

/**
 * The company an invoice is for, from the metadata Stripe copied off the
 * subscription — which copied it off our checkout.
 *
 * Two places: `subscription_details.metadata` (on the invoice directly, or under
 * `parent` on newer API versions), and the first line's metadata, which Stripe
 * also fills from the subscription and which every version carries.
 */
function invoiceTenantHint(invoice: Record<string, unknown>): string | null {
  const lines = (invoice.lines as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];
  return (
    metadataText(subscriptionDetails(invoice), 'tenant_id') ??
    metadataText(lines[0] ?? {}, 'tenant_id')
  );
}

function subscriptionDetails(invoice: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(invoice.subscription_details)) {
    return invoice.subscription_details;
  }
  const parent = invoice.parent;
  const nested = isRecord(parent) ? parent.subscription_details : undefined;
  return isRecord(nested) ? nested : {};
}

/** A string out of an object's `metadata`, when it has one. */
function metadataText(object: Record<string, unknown>, key: string): string | null {
  return isRecord(object.metadata) ? text(object.metadata, key) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The fields of a Stripe invoice this system reads. The object has two hundred more. */
interface StripeInvoice {
  id: string;
  number: string | null;
  status: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  period_start: number | null;
  period_end: number | null;
  created: number;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

function toInvoice(invoice: StripeInvoice): Invoice {
  return {
    id: invoice.id,
    number: invoice.number,
    status: mapInvoiceStatus(invoice.status),
    amountDueCents: invoice.amount_due,
    amountPaidCents: invoice.amount_paid,
    // Stripe sends `gbp`; `Intl` and `plan_allowances` both say `GBP`.
    currency: invoice.currency.toUpperCase(),
    periodStart: seconds(invoice.period_start),
    periodEnd: seconds(invoice.period_end),
    createdAt: seconds(invoice.created) ?? new Date(0),
    hostedUrl: invoice.hosted_invoice_url,
    pdfUrl: invoice.invoice_pdf,
  };
}

/**
 * Stripe's invoice statuses are already ours — the list was taken from theirs
 * — so this only guards against a value added later. An unknown status reads
 * as `open`, which is the one that makes somebody look rather than relax.
 */
function mapInvoiceStatus(status: string | null): InvoiceStatus {
  return (INVOICE_STATUSES as readonly string[]).includes(status ?? '')
    ? (status as InvoiceStatus)
    : 'open';
}

function text(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function seconds(value: unknown): Date | null {
  return typeof value === 'number' ? new Date(value * 1000) : null;
}
