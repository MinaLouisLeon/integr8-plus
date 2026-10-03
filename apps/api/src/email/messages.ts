import type { EmailMessage } from './sender.js';

/**
 * The messages this system sends (P18).
 *
 * All of them in one file, because the set should stay small enough to read in
 * one sitting. Every message obeys three rules:
 *
 * - **The text part is written first and the HTML follows it.** Not the other
 *   way round: a message drafted as HTML and flattened afterwards reads like a
 *   flattened web page, and plain text is what a phone on a roof renders.
 * - **The link is shown, not just linked.** A URL hidden behind "click here"
 *   is indistinguishable from a phishing link, and these arrive unexpectedly.
 * - **No images, no tracking pixels, no remote CSS.** Anything remote is
 *   blocked by default in most clients, so a message that depends on it
 *   arrives broken — and a pixel that reports back is a thing we would have to
 *   disclose.
 */

/** Wraps the body in the least markup that renders sensibly everywhere. */
function layout(title: string, paragraphs: readonly string[], action?: Action): string {
  const body = paragraphs.map((text) => `<p style="${P}">${escapeHtml(text)}</p>`).join('\n      ');

  const button =
    action === undefined
      ? ''
      : `
      <p style="${P}">
        <a href="${escapeHtml(action.url)}" style="${BUTTON}">${escapeHtml(action.label)}</a>
      </p>
      <p style="${SMALL}">
        Or paste this into your browser:<br />
        <span style="word-break: break-all">${escapeHtml(action.url)}</span>
      </p>`;

  return `<!doctype html>
<html>
  <body style="${BODY}">
    <div style="${CARD}">
      <h1 style="${H1}">${escapeHtml(title)}</h1>
      ${body}${button}
    </div>
  </body>
</html>`;
}

interface Action {
  label: string;
  url: string;
}

// Inline styles, because a <style> block is stripped by several clients and a
// remote stylesheet is blocked by most.
const BODY = 'margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;';
const CARD = 'max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;';
const H1 = 'margin:0 0 16px;font-size:20px;line-height:1.3;color:#18181b;';
const P = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;';
const SMALL = 'margin:0 0 16px;font-size:13px;line-height:1.6;color:#71717a;';
const BUTTON =
  'display:inline-block;padding:10px 18px;border-radius:6px;background:#18181b;color:#fff;text-decoration:none;font-weight:600;';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** `2 March 2026`, in UTC. A deadline in the reader's timezone is a guess. */
function day(at: Date): string {
  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function compose(input: {
  to: string;
  subject: string;
  title: string;
  paragraphs: readonly string[];
  action?: Action;
}): EmailMessage {
  const lines = [...input.paragraphs];
  if (input.action !== undefined) {
    lines.push(`${input.action.label}:`, input.action.url);
  }

  return {
    to: input.to,
    subject: input.subject,
    text: lines.join('\n\n'),
    html: layout(input.title, input.paragraphs, input.action),
  };
}

/**
 * Somebody has been invited to join a company.
 *
 * Names who invited them and which company, because an unexpected invitation
 * with neither is indistinguishable from a phishing attempt — and this one
 * arrives at an address the recipient never gave us.
 */
export function invitationEmail(input: {
  to: string;
  companyName: string;
  invitedBy: string;
  acceptUrl: string;
  expiresAt: Date;
}): EmailMessage {
  return compose({
    to: input.to,
    subject: `${input.invitedBy} has invited you to ${input.companyName}`,
    title: `Join ${input.companyName}`,
    paragraphs: [
      `${input.invitedBy} has invited you to join ${input.companyName} on Integr8 Plus.`,
      `Accepting sets up your account. The invitation expires on ${day(input.expiresAt)}.`,
      'If you were not expecting this, you can ignore it — nothing happens until you accept.',
    ],
    action: { label: 'Accept the invitation', url: input.acceptUrl },
  });
}

/**
 * Somebody has signed up and has to prove they own the address.
 *
 * Nothing is created until they click: no company, no bucket, no trial. Said in
 * the message, because it is also the honest answer to "what did I just sign
 * up for".
 */
export function signupVerificationEmail(input: {
  to: string;
  companyName: string;
  verifyUrl: string;
  expiresAt: Date;
}): EmailMessage {
  return compose({
    to: input.to,
    subject: 'Confirm your email address',
    title: 'Confirm your email address',
    paragraphs: [
      `Somebody — we hope you — started setting up ${input.companyName} on Integr8 Plus.`,
      `Confirming creates the company and starts your trial. The link expires on ${day(input.expiresAt)}.`,
      'If this was not you, ignore this message. Nothing has been created yet, and nothing will be.',
    ],
    action: { label: 'Confirm and create the company', url: input.verifyUrl },
  });
}

/**
 * A payment has failed, or a trial has run out (P17).
 *
 * The message P17 could not send. `deadline` is the day writing stops, or null
 * once it already has — the two want different words, and getting them the
 * wrong way round tells somebody their account is fine when it is not.
 */
export function dunningEmail(input: {
  to: string;
  companyName: string;
  billingUrl: string;
  deadline: Date | null;
  readOnly: boolean;
}): EmailMessage {
  const paragraphs = input.readOnly
    ? [
        `${input.companyName} is now read-only because a payment is outstanding.`,
        'Nothing has been deleted and nothing will be. Everything can still be read and exported; what has stopped is saving new work.',
        'Updating your card restores it straight away.',
      ]
    : [
        `A payment for ${input.companyName} has not gone through.`,
        input.deadline === null
          ? 'Please update your card to keep everything working.'
          : `If it is still outstanding on ${day(input.deadline)}, the account becomes read-only — your data stays, but new work cannot be saved.`,
        'Updating your card takes a minute and fixes it immediately.',
      ];

  return compose({
    to: input.to,
    subject: input.readOnly
      ? `${input.companyName} is read-only — payment outstanding`
      : `Payment failed for ${input.companyName}`,
    title: input.readOnly ? 'Your account is read-only' : 'A payment did not go through',
    paragraphs,
    action: { label: 'Update your card', url: input.billingUrl },
  });
}
