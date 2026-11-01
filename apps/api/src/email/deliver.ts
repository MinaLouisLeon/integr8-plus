import { getPlatformDataSource } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../http/logger.js';
import { acceptInvitationUrl } from './links.js';
import {
  businessDocumentEmail,
  type EmailLocale,
  invitationEmail,
  passwordChangedEmail,
  signInCodeEmail,
} from './messages.js';
import type { EmailSender } from './sender.js';

/**
 * Putting a message in the post, without letting the post decide the outcome
 * (P18).
 *
 * Every caller here has already done the thing that matters — the invitation
 * row exists, the company exists — and the message is the last step. So a
 * failure is **recorded and swallowed**, never thrown: an invitation whose
 * email bounced is still a valid invitation, and turning that into a 500 would
 * roll back work that succeeded and tell the inviter their invitation failed
 * when it did not.
 *
 * What the caller gets back is whether it went, so a screen can say "sent" or
 * "created, but we could not email it" rather than guessing.
 */

export interface Delivery {
  sent: boolean;
  /** Why not, when it did not. Safe to show an admin; never shown to a stranger. */
  problem: string | null;
}

const NOT_SENT: Delivery = { sent: false, problem: null };

async function post(
  sender: EmailSender,
  logger: Logger,
  message: Parameters<EmailSender['send']>[0],
  context: Record<string, unknown>,
): Promise<Delivery> {
  const result = await sender.send(message);

  if (result.status === 'sent') {
    // The address is not logged. It is somebody's email, the log is read by
    // people who have no business reading it, and the id is enough to trace a
    // delivery at the provider.
    //
    // The link is logged for the recording sender and no other. With the fake
    // there is no mailbox, so the log is the only place a staging deployment
    // can read its own confirmation link; with a real provider the same line
    // would hand a token to anyone who reads the log.
    logger.info('Email sent', {
      ...context,
      provider: sender.provider,
      messageId: result.id,
      ...(sender.provider === 'recording' && message.actionUrl !== undefined
        ? { actionUrl: message.actionUrl }
        : {}),
      ...(sender.provider === 'recording' && message.code !== undefined
        ? { code: message.code }
        : {}),
    });
    return { sent: true, problem: null };
  }

  logger.error('Email not sent', {
    ...context,
    provider: sender.provider,
    reason: result.message,
    retryable: result.retryable,
  });
  return { sent: false, problem: result.message };
}

/**
 * Sends somebody their invitation.
 *
 * The token reaches exactly one place: this message. It is not returned by the
 * API, not written to the audit log and not logged here — anybody who could
 * read it could accept on the invitee's behalf.
 */
export async function deliverInvitation(input: {
  sender: EmailSender;
  config: ApiConfig;
  logger: Logger;
  tenantId: string;
  email: string;
  token: string;
  invitedBy: string;
  expiresAt: Date;
}): Promise<Delivery> {
  const url = acceptInvitationUrl(input.config.WEB_APP_URL, input.token);
  if (url === null) {
    input.logger.error('Invitation not sent: WEB_APP_URL is not configured', {
      tenantId: input.tenantId,
    });
    return { sent: false, problem: 'WEB_APP_URL is not configured.' };
  }

  const tenant = await getPlatformDataSource().tenants.findById(input.tenantId);
  if (tenant === undefined) {
    return NOT_SENT;
  }

  return post(
    input.sender,
    input.logger,
    invitationEmail({
      to: input.email,
      companyName: tenant.name,
      invitedBy: input.invitedBy,
      acceptUrl: url,
      expiresAt: input.expiresAt,
    }),
    { kind: 'invitation', tenantId: input.tenantId },
  );
}

/**
 * Sends somebody the sign-in code they asked for (P36).
 *
 * Like the invitation token, the code reaches exactly one place: this message.
 * It is logged only for the recording sender, where there is no mailbox.
 */
export function deliverSignInCode(input: {
  sender: EmailSender;
  logger: Logger;
  email: string;
  code: string;
  minutes: number;
  locale: EmailLocale;
}): Promise<Delivery> {
  return post(
    input.sender,
    input.logger,
    signInCodeEmail({
      to: input.email,
      code: input.code,
      minutes: input.minutes,
      locale: input.locale,
    }),
    { kind: 'sign_in_code' },
  );
}

/** Tells somebody their password was changed (P36). */
export function deliverPasswordChanged(input: {
  sender: EmailSender;
  logger: Logger;
  email: string;
  changedAt: Date;
  locale: EmailLocale;
  tenantId: string;
}): Promise<Delivery> {
  return post(
    input.sender,
    input.logger,
    passwordChangedEmail({ to: input.email, changedAt: input.changedAt, locale: input.locale }),
    { kind: 'password_changed', tenantId: input.tenantId },
  );
}

/** Sends a message that has already been composed. For signup and dunning. */
export function deliver(
  sender: EmailSender,
  logger: Logger,
  message: Parameters<EmailSender['send']>[0],
  context: Record<string, unknown> = {},
): Promise<Delivery> {
  return post(sender, logger, message, context);
}

/**
 * Sends a business PDF to the customer or supplier it is for (1.3.0). The
 * person asked for it from the record's screen, so the answer is shown to
 * them: sent, or why not.
 */
export async function deliverBusinessDocument(input: {
  sender: EmailSender;
  logger: Logger;
  tenantId: string;
  to: string;
  companyName: string;
  documentTitle: string;
  note: string | null;
  attachment: { filename: string; content: Uint8Array };
  replyTo?: string;
  locale: EmailLocale;
}): Promise<Delivery> {
  return post(
    input.sender,
    input.logger,
    businessDocumentEmail({
      to: input.to,
      companyName: input.companyName,
      documentTitle: input.documentTitle,
      note: input.note,
      attachment: input.attachment,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      locale: input.locale,
    }),
    { kind: 'business_document', tenantId: input.tenantId },
  );
}
