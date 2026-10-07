import { describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { deliver } from './deliver.js';
import { signupVerificationEmail } from './messages.js';
import { RecordingEmailSender, type EmailMessage, type EmailResult } from './sender.js';

/**
 * What the delivery log carries (P18).
 *
 * A staging deployment runs with the recording sender and no mailbox, so the
 * confirmation and invitation links have to be readable in its log or signing
 * up cannot be tested at all. A real provider's log must never carry them.
 */

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

const message = signupVerificationEmail({
  to: 'owner@example.com',
  companyName: 'Acme Field',
  verifyUrl: 'https://app.example.com/sign-up/verify?token=abc123',
  expiresAt: new Date('2026-03-02T12:00:00Z'),
});

describe('the delivery log', () => {
  it('writes the link when the recording sender is in use, and never the address', async () => {
    const { logger, lines } = capture();
    const sender = new RecordingEmailSender();

    const outcome = await deliver(sender, logger, message, { kind: 'signup' });

    expect(outcome.sent).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      message: 'Email sent',
      kind: 'signup',
      provider: 'recording',
      actionUrl: 'https://app.example.com/sign-up/verify?token=abc123',
    });
    expect(JSON.stringify(lines[0])).not.toContain('owner@example.com');
  });

  it('keeps the link out of the log for a real provider', async () => {
    const { logger, lines } = capture();
    const realish = {
      provider: 'resend',
      send: (_message: EmailMessage): Promise<EmailResult> =>
        Promise.resolve({ status: 'sent', id: 'msg_1' }),
    };

    await deliver(realish, logger, message, { kind: 'signup' });

    expect(lines[0]).toMatchObject({ message: 'Email sent', provider: 'resend' });
    expect(lines[0]).not.toHaveProperty('actionUrl');
    expect(JSON.stringify(lines[0])).not.toContain('token=');
  });
});
