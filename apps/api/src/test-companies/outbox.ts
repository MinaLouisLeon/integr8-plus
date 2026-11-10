import { getPlatformDataSource } from '@integr8/db';
import type { EmailMessage } from '../email/sender.js';
import type { PushMessage, PushSender, PushTicket } from '../push/sender.js';

/**
 * Test companies send nothing (0077, P38).
 *
 * A test company's mail and push notifications are written to its outbox
 * (`test_outbox`, kept 7 days) instead of being handed to Resend or Expo, so
 * the developer MCP server can read back what the customer or the engineer
 * would have received, and nobody receives anything. The two places every
 * message leaves from call these: `email/deliver.ts` for mail and the push
 * senders' callers for push.
 */

/** The mark never changes after a company is created, so an answer is kept. */
const known = new Map<string, boolean>();
const KNOWN_LIMIT = 5000;

export async function isTestCompany(tenantId: string): Promise<boolean> {
  const cached = known.get(tenantId);
  if (cached !== undefined) {
    return cached;
  }
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  const isTest = tenant?.isTest === true;
  if (tenant !== undefined) {
    if (known.size >= KNOWN_LIMIT) {
      known.clear();
    }
    known.set(tenantId, isTest);
  }
  return isTest;
}

/** Whether every one of these companies is a test company (and there is at least one). */
export async function onlyTestCompanies(tenantIds: readonly string[]): Promise<boolean> {
  if (tenantIds.length === 0) {
    return false;
  }
  for (const tenantId of tenantIds) {
    if (!(await isTestCompany(tenantId))) {
      return false;
    }
  }
  return true;
}

/** Keeps one email in a test company's outbox. */
export async function keepTestEmail(
  tenantId: string,
  message: EmailMessage,
  kind: string | undefined,
): Promise<void> {
  await getPlatformDataSource().testOutbox.record({
    tenantId,
    channel: 'email',
    recipient: message.to,
    subject: message.subject,
    body: message.text,
    details: {
      ...(kind === undefined ? {} : { kind }),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.actionUrl === undefined ? {} : { actionUrl: message.actionUrl }),
      attachments: (message.attachments ?? []).map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        bytes: attachment.content.length,
      })),
    },
  });
}

/** The end of a push token, enough to tell phones apart without keeping the token. */
const deviceLabel = (token: string) => `device …${token.slice(-6)}`;

/** Keeps push notifications in a test company's outbox. */
export async function keepTestPush(
  tenantId: string,
  messages: readonly PushMessage[],
): Promise<void> {
  const outbox = getPlatformDataSource().testOutbox;
  for (const message of messages) {
    await outbox.record({
      tenantId,
      channel: 'push',
      recipient: deviceLabel(message.to),
      subject: message.title,
      body: message.body,
      details: { data: message.data, channelId: message.channelId, priority: message.priority },
    });
  }
}

/**
 * Sends push notifications, or keeps them when the company is a test company.
 * Returns the tickets, or `kept` when nothing was sent.
 */
export async function sendPushOrKeep(
  sender: PushSender,
  tenantId: string,
  messages: readonly PushMessage[],
): Promise<PushTicket[] | 'kept'> {
  if (await isTestCompany(tenantId)) {
    await keepTestPush(tenantId, messages);
    return 'kept';
  }
  return sender.send(messages);
}
