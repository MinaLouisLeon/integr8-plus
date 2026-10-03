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
    });
  });

  it('records what it does not act on rather than refusing it', () => {
    const parsed = deliver({ id: 'evt_5', type: 'customer.created', data: { object: {} } });

    expect(parsed.event).toEqual({ kind: 'ignored' });
    // Still carries the type and the payload, because the record is what makes
    // an argument with a provider winnable.
    expect(parsed.type).toBe('customer.created');
  });
});

describe('the fake', () => {
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
});
