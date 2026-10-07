/**
 * Sending email (P18).
 *
 * The piece this system has done without since P07, and the one that several
 * finished features have been quietly waiting for: an invitation has always
 * produced a token that nothing delivered, and P17's dunning reminders have
 * been in-app only because there was nowhere else to put them.
 *
 * Behind an interface for the same reason billing is. A deployment picks its
 * sender with `EMAIL_SENDER`, production refuses the fake, and the two things
 * a message needs — an address and some words — say nothing about who carries
 * it. Swapping Resend for SES is a new class and a config value.
 *
 * **Every message is both HTML and plain text.** Not politeness: a mail client
 * that shows only the text part is common enough in the trades this product
 * sells to, and an invitation nobody can read is an invitation nobody accepts.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** The words, as text. Always sent, and always written first. */
  text: string;
  /** The same words as HTML. */
  html: string;
  /**
   * Overrides the deployment's default sender.
   *
   * Rarely wanted, and never settable from a request: a caller that could
   * choose the from-address could send mail that appears to come from anybody
   * this domain can vouch for.
   */
  from?: string;
  /**
   * The one link the message exists to deliver, when there is one: the
   * invitation, the signup confirmation, the billing page.
   *
   * Carried separately from the words so the recording sender can put it in
   * the log. A staging deployment has no mailbox to read, and a confirmation
   * link that reaches nowhere makes signing up impossible to test.
   */
  actionUrl?: string;
}

export type EmailResult =
  { status: 'sent'; id: string } | { status: 'error'; message: string; retryable: boolean };

export interface EmailSender {
  readonly provider: string;
  /**
   * Sends one message.
   *
   * Returns a result rather than throwing, because every caller in this system
   * has something more important to protect than the email. An invitation whose
   * message failed is still an invitation; a signup whose verification bounced
   * is still an account. Callers record the failure and carry on.
   */
  send(message: EmailMessage): Promise<EmailResult>;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

/**
 * Keeps what would have been sent, for development and tests.
 *
 * The addresses are deliberately not validated and nothing is rendered: this
 * exists so a test can assert that a message was produced. The link a message
 * carries is written to the log by `deliver` when this sender is in use, so a
 * developer or a staging deployment can follow it without owning a domain.
 */
export class RecordingEmailSender implements EmailSender {
  readonly provider = 'recording';
  readonly sent: EmailMessage[] = [];
  #next = 0;

  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    this.#next += 1;
    return Promise.resolve({ status: 'sent', id: `recorded-${String(this.#next)}` });
  }

  /** The most recent message to an address, for a test that has just acted. */
  lastTo(address: string): EmailMessage | undefined {
    return this.sent.filter((message) => message.to === address).at(-1);
  }
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

const RESEND_API = 'https://api.resend.com/emails';

export interface ResendOptions {
  apiKey: string;
  /** `Name <address@domain>`; the domain has to be verified at the provider. */
  from: string;
  fetch?: typeof fetch;
}

/**
 * Resend, over its REST API with `fetch` and no SDK.
 *
 * The same choice made for Stripe, for the same reason: one POST with a JSON
 * body does not need a dependency, and a dependency is a supply chain.
 */
export class ResendEmailSender implements EmailSender {
  readonly provider = 'resend';
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;

  constructor(options: ResendOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#fetch = options.fetch ?? fetch;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    let response: Response;
    try {
      response = await this.#fetch(RESEND_API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from ?? this.#from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (error) {
      // The network, not the provider. Worth retrying.
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }

    if (response.ok) {
      const body = (await response.json()) as { id?: string };
      return { status: 'sent', id: body.id ?? '' };
    }

    // 4xx is us — a bad address, an unverified domain, a revoked key — and
    // retrying sends the same wrong request again. 429 is the exception: it is
    // a 4xx that means "later", not "never".
    const retryable = response.status >= 500 || response.status === 429;
    return {
      status: 'error',
      message: `${String(response.status)} ${await response.text().catch(() => '')}`.trim(),
      retryable,
    };
  }
}
