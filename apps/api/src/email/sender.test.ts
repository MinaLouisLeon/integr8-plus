import { describe, expect, it } from 'vitest';
import { acceptInvitationUrl, billingUrl, verifySignupUrl } from './links.js';
import { dunningEmail, invitationEmail, signupVerificationEmail } from './messages.js';
import { RecordingEmailSender, ResendEmailSender } from './sender.js';

/**
 * The email layer, without sending any (P18).
 *
 * Three things are worth testing here and nothing else is: that a failure is
 * classified correctly as worth retrying or not, that a link is never half
 * built, and that every message carries its words in both parts.
 */

const EXPIRES = new Date('2026-03-02T12:00:00Z');

function respondWith(status: number, body = '{}'): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    );
}

describe('the Resend adapter', () => {
  it('sends both parts, to one address, from the configured sender', async () => {
    let seen: Record<string, unknown> = {};
    const sender = new ResendEmailSender({
      apiKey: 'key',
      from: 'Integr8 <hello@integr8.example>',
      fetch: ((_url: string, init: RequestInit) => {
        seen = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<
          string,
          unknown
        >;
        return Promise.resolve(new Response('{"id":"abc"}', { status: 200 }));
      }) as unknown as typeof fetch,
    });

    const result = await sender.send({
      to: 'someone@example.com',
      subject: 'Hello',
      text: 'plain',
      html: '<p>rich</p>',
    });

    expect(result).toEqual({ status: 'sent', id: 'abc' });
    expect(seen).toMatchObject({
      from: 'Integr8 <hello@integr8.example>',
      to: ['someone@example.com'],
      text: 'plain',
      html: '<p>rich</p>',
    });
  });

  it('treats a rejected address as final, and a rate limit as worth retrying', async () => {
    const rejected = await new ResendEmailSender({
      apiKey: 'k',
      from: 'f',
      fetch: respondWith(422, 'invalid address'),
    }).send({ to: 'nope', subject: 's', text: 't', html: 'h' });

    // Retrying sends the same wrong request again, for ever.
    expect(rejected).toMatchObject({ status: 'error', retryable: false });

    const limited = await new ResendEmailSender({
      apiKey: 'k',
      from: 'f',
      fetch: respondWith(429),
    }).send({ to: 'a@b.c', subject: 's', text: 't', html: 'h' });

    // The one 4xx that means "later" rather than "never".
    expect(limited).toMatchObject({ status: 'error', retryable: true });

    const broken = await new ResendEmailSender({
      apiKey: 'k',
      from: 'f',
      fetch: respondWith(503),
    }).send({ to: 'a@b.c', subject: 's', text: 't', html: 'h' });
    expect(broken).toMatchObject({ status: 'error', retryable: true });
  });

  it('turns a network failure into a retryable error rather than throwing', async () => {
    const sender = new ResendEmailSender({
      apiKey: 'k',
      from: 'f',
      fetch: () => Promise.reject(new Error('ECONNRESET')),
    });

    // Throwing would take down whatever was being done when the mail was sent,
    // and the invitation matters more than the message about it.
    await expect(
      sender.send({ to: 'a@b.c', subject: 's', text: 't', html: 'h' }),
    ).resolves.toMatchObject({ status: 'error', retryable: true, message: 'ECONNRESET' });
  });
});

describe('links', () => {
  it('returns null rather than a guess when no web address is configured', () => {
    // A half-right link is worse than none: the person tries it, it fails, and
    // nobody finds out until they give up.
    expect(acceptInvitationUrl(undefined, 'tok')).toBeNull();
    expect(verifySignupUrl('', 'tok')).toBeNull();
    expect(billingUrl(undefined)).toBeNull();
  });

  it('escapes the token and tolerates a trailing slash on the base', () => {
    expect(acceptInvitationUrl('https://app.example/', 'a b+c')).toBe(
      'https://app.example/accept-invitation?token=a%20b%2Bc',
    );
  });
});

describe('the messages', () => {
  it('names who invited them and which company, and shows the link as text', () => {
    const message = invitationEmail({
      to: 'new@example.com',
      companyName: 'Northwind Gas',
      invitedBy: 'Sam Patel',
      acceptUrl: 'https://app.example/accept-invitation?token=xyz',
      expiresAt: EXPIRES,
    });

    // An unexpected invitation naming nobody is indistinguishable from
    // phishing, and this arrives at an address its recipient never gave us.
    expect(message.subject).toContain('Sam Patel');
    expect(message.subject).toContain('Northwind Gas');
    expect(message.text).toContain('2 March 2026');
    // The URL is readable in both parts, not hidden behind "click here".
    expect(message.text).toContain('https://app.example/accept-invitation?token=xyz');
    expect(message.html).toContain('https://app.example/accept-invitation?token=xyz');
  });

  it('promises nothing has been created yet, because nothing has', () => {
    const message = signupVerificationEmail({
      to: 'owner@example.com',
      companyName: 'Southgate Plumbing',
      verifyUrl: 'https://app.example/sign-up/verify?token=xyz',
      expiresAt: EXPIRES,
    });

    expect(message.text).toContain('Nothing has been created yet');
  });

  it('says different things before and after the writes stop', () => {
    const warning = dunningEmail({
      to: 'owner@example.com',
      companyName: 'Northwind Gas',
      billingUrl: 'https://app.example/billing',
      deadline: EXPIRES,
      readOnly: false,
    });
    expect(warning.text).toContain('2 March 2026');
    expect(warning.text).not.toContain('is now read-only');

    const stopped = dunningEmail({
      to: 'owner@example.com',
      companyName: 'Northwind Gas',
      billingUrl: 'https://app.example/billing',
      deadline: null,
      readOnly: true,
    });
    // The promise that matters most, in the message that matters most.
    expect(stopped.text).toContain('Nothing has been deleted and nothing will be');
  });

  it('escapes the company name into the HTML part', () => {
    const message = invitationEmail({
      to: 'a@b.c',
      companyName: '<script>alert(1)</script> Ltd',
      invitedBy: 'Sam',
      acceptUrl: 'https://app.example/x',
      expiresAt: EXPIRES,
    });

    // A company can call itself anything, and the name reaches a mail client
    // that will happily render markup.
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});

describe('the recording fake', () => {
  it('keeps what would have been sent, newest last', async () => {
    const sender = new RecordingEmailSender();
    await sender.send({ to: 'a@b.c', subject: 'first', text: 't', html: 'h' });
    await sender.send({ to: 'a@b.c', subject: 'second', text: 't', html: 'h' });

    expect(sender.sent).toHaveLength(2);
    expect(sender.lastTo('a@b.c')?.subject).toBe('second');
    expect(sender.lastTo('nobody@b.c')).toBeUndefined();
  });
});
