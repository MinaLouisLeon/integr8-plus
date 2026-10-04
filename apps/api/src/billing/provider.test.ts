import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RecordingBillingProvider,
  STRIPE_TOLERANCE_SECONDS,
  StripeBillingProvider,
  verifyStripeSignature,
  WebhookSignatureError,
} from './provider.js';

/**
 * The webhook signature, which is the one part of Stripe worth owning and the
 * one part testable without an account.
 *
 * Everything else in the adapter is a POST to somebody else's server. This is
 * the check that decides whether a stranger can move a company onto a paid
 * plan by sending us JSON, so it is tested against the real algorithm rather
 * than trusted.
 */

const SECRET = 'whsec_a_test_endpoint_secret';
const BODY = '{"id":"evt_1","type":"invoice.payment_failed"}';
const NOW = new Date('2026-09-16T12:00:00.000Z');

/** A header the way Stripe builds one. */
function sign(body: string, at: Date, secret = SECRET): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex');
  return `t=${String(timestamp)},v1=${signature}`;
}

describe('verifying a Stripe signature', () => {
  it('accepts a header it signed itself', () => {
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header: sign(BODY, NOW), secret: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it('refuses a body changed after signing', () => {
    const header = sign(BODY, NOW);
    const tampered = BODY.replace('payment_failed', 'payment_succeeded');

    expect(() =>
      verifyStripeSignature({ rawBody: tampered, header, secret: SECRET, now: NOW }),
    ).toThrow(WebhookSignatureError);
  });

  it('refuses a signature made with a different secret', () => {
    const header = sign(BODY, NOW, 'whsec_somebody_elses_secret');

    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).toThrow(WebhookSignatureError);
  });

  /**
   * The replay window. Without the timestamp check, a delivery captured off the
   * wire stays valid for ever, and "payment succeeded" is a useful thing to
   * replay.
   */
  it('refuses a delivery older than the tolerance, and accepts one inside it', () => {
    const old = new Date(NOW.getTime() - (STRIPE_TOLERANCE_SECONDS + 60) * 1000);
    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header: sign(BODY, old), secret: SECRET, now: NOW }),
    ).toThrow(WebhookSignatureError);

    const recent = new Date(NOW.getTime() - 60 * 1000);
    expect(() =>
      verifyStripeSignature({
        rawBody: BODY,
        header: sign(BODY, recent),
        secret: SECRET,
        now: NOW,
      }),
    ).not.toThrow();
  });

  it('refuses a timestamp far in the future, not only far in the past', () => {
    const ahead = new Date(NOW.getTime() + (STRIPE_TOLERANCE_SECONDS + 60) * 1000);

    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header: sign(BODY, ahead), secret: SECRET, now: NOW }),
    ).toThrow(WebhookSignatureError);
  });

  it('accepts any of several signatures, which is how a secret is rotated', () => {
    const mine = sign(BODY, NOW).split('v1=')[1] ?? '';
    const header = `t=${String(Math.floor(NOW.getTime() / 1000))},v1=${'0'.repeat(64)},v1=${mine}`;

    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).not.toThrow();
  });

  it('refuses a header that is missing, empty or malformed', () => {
    for (const header of [undefined, '', 'nonsense', 't=123', `v1=${'0'.repeat(64)}`]) {
      expect(() =>
        verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
      ).toThrow(WebhookSignatureError);
    }
  });

  it('refuses a signature of the wrong length rather than throwing', () => {
    // `timingSafeEqual` throws on a length mismatch; a short candidate must be
    // a plain refusal, not a 500.
    const header = `t=${String(Math.floor(NOW.getTime() / 1000))},v1=abc`;

    expect(() =>
      verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, now: NOW }),
    ).toThrow(WebhookSignatureError);
  });
});

describe('translating Stripe into our words', () => {
  const provider = new StripeBillingProvider({
    secretKey: 'sk_test',
    webhookSecret: SECRET,
    now: () => NOW,
  });

  const deliver = (body: unknown) => {
    const raw = JSON.stringify(body);
    return provider.parseWebhook(raw, sign(raw, NOW));
  };

  it('reads a subscription change, its period and its price', () => {
    const parsed = deliver({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          current_period_start: 1_760_000_000,
          current_period_end: 1_762_000_000,
          items: {
            data: [{ quantity: 7, price: { id: 'price_1', recurring: { interval: 'month' } } }],
          },
        },
      },
    });

    expect(parsed.id).toBe('evt_2');
    expect(parsed.event).toMatchObject({
      kind: 'subscription_changed',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      priceId: 'price_1',
      interval: 'month',
      quantity: 7,
      cancelAtPeriodEnd: false,
    });
  });

  it('treats a deletion as cancelled whatever the status on the object says', () => {
    const parsed = deliver({
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', items: { data: [] } } },
    });

    expect(parsed.event).toMatchObject({ kind: 'subscription_changed', status: 'canceled' });
  });

  /**
   * The statuses that decide whether somebody keeps working. `unpaid` and
   * `incomplete_expired` mean nobody is paying and nobody is going to; `paused`
   * must not read as active, because the one outcome to avoid is full access
   * while nothing is being collected.
   */
  it('maps every status onto one of ours, erring towards not-paying', () => {
    const statusOf = (status: string) => {
      const parsed = deliver({
        id: `evt_${status}`,
        type: 'customer.subscription.updated',
        data: { object: { id: 'sub_1', customer: 'cus_1', status, items: { data: [] } } },
      });
      return parsed.event.kind === 'subscription_changed' ? parsed.event.status : 'ignored';
    };

    expect(statusOf('trialing')).toBe('trialing');
    expect(statusOf('active')).toBe('active');
    expect(statusOf('past_due')).toBe('past_due');
    expect(statusOf('paused')).toBe('past_due');
    expect(statusOf('incomplete')).toBe('incomplete');
    expect(statusOf('unpaid')).toBe('canceled');
    expect(statusOf('incomplete_expired')).toBe('canceled');
    expect(statusOf('something_stripe_added_later')).toBe('canceled');
  });

  it('carries the company through a completed checkout', () => {
    const parsed = deliver({
      id: 'evt_4',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          client_reference_id: '00000000-0000-4000-8000-000000000001',
        },
      },
    });

    expect(parsed.event).toEqual({
      kind: 'checkout_completed',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      tenantId: '00000000-0000-4000-8000-000000000001',
      priceId: null,
      status: null,
    });
  });

  it('reads the price and the payment state our checkout put on the session', () => {
    const parsed = deliver({
      id: 'evt_4b',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          // No `client_reference_id`: the metadata carries the same value.
          metadata: { tenant_id: '00000000-0000-4000-8000-000000000001', price_id: 'price_1' },
          payment_status: 'paid',
        },
      },
    });

    expect(parsed.event).toMatchObject({
      kind: 'checkout_completed',
      tenantId: '00000000-0000-4000-8000-000000000001',
      priceId: 'price_1',
      status: 'active',
    });

    // A checkout that opens with a trial collected nothing, and says so.
    const trial = deliver({
      id: 'evt_4c',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', payment_status: 'no_payment_required' } },
    });
    expect(trial.event).toMatchObject({ kind: 'checkout_completed', status: 'trialing' });
  });

  /**
   * Stripe does not order deliveries, and the subscription and invoice events
   * for a first purchase usually land before the checkout event that carries
   * `client_reference_id`. Our checkout puts the company on the subscription's
   * metadata, and Stripe copies it onto every invoice; reading it back is what
   * lets those earlier events find their company.
   */
  it('carries the company our checkout named on a subscription, as a hint', () => {
    const parsed = deliver({
      id: 'evt_6',
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          metadata: { tenant_id: '00000000-0000-4000-8000-000000000001' },
          items: { data: [] },
        },
      },
    });

    expect(parsed.event).toMatchObject({
      kind: 'subscription_changed',
      tenantHint: '00000000-0000-4000-8000-000000000001',
    });

    const bare = deliver({
      id: 'evt_7',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_2', customer: 'cus_2', status: 'active', items: { data: [] } } },
    });
    expect(bare.event).toMatchObject({ kind: 'subscription_changed', tenantHint: null });
  });

  it('carries the hint on an invoice, wherever the API version puts it', () => {
    const tenant = '00000000-0000-4000-8000-000000000001';

    const classic = deliver({
      id: 'evt_8',
      type: 'invoice.paid',
      data: {
        object: {
          customer: 'cus_1',
          subscription: 'sub_1',
          subscription_details: { metadata: { tenant_id: tenant } },
        },
      },
    });
    expect(classic.event).toEqual({
      kind: 'payment_succeeded',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      tenantHint: tenant,
    });

    // From API version 2025-03-31 the subscription moved under `parent`.
    const basil = deliver({
      id: 'evt_9',
      type: 'invoice.payment_failed',
      data: {
        object: {
          customer: 'cus_1',
          parent: {
            subscription_details: { subscription: 'sub_1', metadata: { tenant_id: tenant } },
          },
        },
      },
    });
    expect(basil.event).toEqual({
      kind: 'payment_failed',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      tenantHint: tenant,
    });

    // And the line items carry the subscription's metadata on every version.
    const fromLines = deliver({
      id: 'evt_10',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          customer: 'cus_1',
          lines: { data: [{ metadata: { tenant_id: tenant } }] },
        },
      },
    });
    expect(fromLines.event).toMatchObject({ kind: 'payment_succeeded', tenantHint: tenant });

    const none = deliver({
      id: 'evt_11',
      type: 'invoice.paid',
      data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
    });
    expect(none.event).toMatchObject({ kind: 'payment_succeeded', tenantHint: null });
  });

  it('records what it does not act on rather than refusing it', () => {
    const parsed = deliver({ id: 'evt_5', type: 'customer.created', data: { object: {} } });

    expect(parsed.event).toEqual({ kind: 'ignored' });
    // Still carries the type and the payload, because the record is what makes
    // an argument with a provider winnable.
    expect(parsed.type).toBe('customer.created');
  });
});

describe('listing invoices from Stripe', () => {
  it('asks for the customer’s last two years and translates each invoice', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const provider = new StripeBillingProvider({
      secretKey: 'sk_test',
      webhookSecret: SECRET,
      fetch: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, method: init?.method });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'in_1',
                  number: 'ACME-0001',
                  status: 'paid',
                  amount_due: 4900,
                  amount_paid: 4900,
                  currency: 'gbp',
                  period_start: 1_756_684_800,
                  period_end: 1_759_276_800,
                  created: 1_759_276_800,
                  hosted_invoice_url: 'https://invoice.stripe.com/i/in_1',
                  invoice_pdf: 'https://pay.stripe.com/invoice/in_1/pdf',
                },
                {
                  id: 'in_0',
                  number: null,
                  status: 'something_new',
                  amount_due: 0,
                  amount_paid: 0,
                  currency: 'gbp',
                  period_start: null,
                  period_end: null,
                  created: 1_756_684_800,
                  hosted_invoice_url: null,
                  invoice_pdf: null,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });

    const invoices = await provider.listInvoices('cus_123');

    // A GET, for this customer, two years of monthly invoices.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBeUndefined();
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/invoices?customer=cus_123&limit=24');

    expect(invoices[0]).toMatchObject({
      id: 'in_1',
      number: 'ACME-0001',
      status: 'paid',
      amountDueCents: 4900,
      amountPaidCents: 4900,
      // Stripe says `gbp`; `Intl` and our own plan rows say `GBP`.
      currency: 'GBP',
      hostedUrl: 'https://invoice.stripe.com/i/in_1',
      pdfUrl: 'https://pay.stripe.com/invoice/in_1/pdf',
    });
    expect(invoices[0]?.periodStart?.toISOString()).toBe('2025-09-01T00:00:00.000Z');
    expect(invoices[0]?.createdAt.toISOString()).toBe('2025-10-01T00:00:00.000Z');

    // A status Stripe adds later reads as open — the one that makes somebody
    // look — rather than as paid or as a crash.
    expect(invoices[1]).toMatchObject({ status: 'open', periodStart: null, hostedUrl: null });
  });
});

describe('the fake', () => {
  it('lists the invoices it issued to a customer, newest first, and nobody else’s', async () => {
    const provider = new RecordingBillingProvider();
    const first = provider.issueInvoice('cus_a');
    const second = provider.issueInvoice('cus_a', { status: 'open', amountPaidCents: 0 });
    provider.issueInvoice('cus_b');

    // Deterministic: the same sequence every run, so a test can say exactly
    // what it expects and a screenshot looks the same twice.
    expect(first).toMatchObject({ id: 'in_test_1', number: 'TEST-0001', status: 'paid' });
    expect(first.hostedUrl).toContain('billing.invalid');

    const listed = await provider.listInvoices('cus_a');
    expect(listed.map((invoice) => invoice.id)).toEqual([second.id, first.id]);
    expect(await provider.listInvoices('cus_nobody')).toEqual([]);
  });

  it('records what it was asked for, and sends nobody anywhere real', async () => {
    const provider = new RecordingBillingProvider();

    const checkout = await provider.createCheckout({
      tenantId: 't',
      tenantName: 'Northwind',
      email: 'owner@northwind.example',
      priceId: 'price_1',
      quantity: 3,
      successUrl: 'https://app.invalid/ok',
      cancelUrl: 'https://app.invalid/no',
    });

    expect(provider.checkouts).toHaveLength(1);
    expect(provider.checkouts[0]?.quantity).toBe(3);
    // Nowhere real, on purpose: a fake that looked like it took a payment is a
    // fake somebody eventually believes.
    expect(checkout.url).toContain('billing.invalid');
  });

  it('fills in the tenant hint a hand-written event leaves out', () => {
    const provider = new RecordingBillingProvider();

    const bare = provider.parseWebhook(
      JSON.stringify({
        id: 'evt_1',
        type: 'invoice.paid',
        event: { kind: 'payment_succeeded', customerId: 'cus_1', subscriptionId: 'sub_1' },
      }),
      undefined,
    );
    expect(bare.event).toMatchObject({ kind: 'payment_succeeded', tenantHint: null });

    // And carries one that is there, so a test can post an event that arrived
    // before the checkout did.
    const hinted = provider.parseWebhook(
      JSON.stringify({
        id: 'evt_2',
        type: 'customer.subscription.created',
        event: { kind: 'subscription_changed', customerId: 'cus_1', tenantHint: 'tenant-1' },
      }),
      undefined,
    );
    expect(hinted.event).toMatchObject({ kind: 'subscription_changed', tenantHint: 'tenant-1' });
  });
});
