import {
  calendarDayWords,
  dayWords,
  fill,
  type MessageLocale,
  wordsFor,
} from '../notifications/words.js';
import { ar, en } from '@integr8/i18n/core';
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

/**
 * The two languages a message can be written in. Reminders go in the company's
 * language (`tenant_settings.locale`); a few, such as the invitation, are
 * English only for now.
 */
export type EmailLocale = MessageLocale;

/** Wraps the body in the least markup that renders sensibly everywhere. */
function layout(
  title: string,
  paragraphs: readonly string[],
  action?: Action,
  locale: EmailLocale = 'en',
  highlight?: string,
): string {
  const body = paragraphs.map((text) => `<p style="${P}">${escapeHtml(text)}</p>`).join('\n      ');

  const button =
    action === undefined
      ? ''
      : `
      <p style="${P}">
        <a href="${escapeHtml(action.url)}" style="${BUTTON}">${escapeHtml(action.label)}</a>
      </p>
      <p style="${SMALL}">
        ${escapeHtml(wordsFor(locale).email.pasteLink)}<br />
        <span style="word-break: break-all">${escapeHtml(action.url)}</span>
      </p>`;

  // A code is shown large and on its own line, isolated left-to-right, so it
  // reads the same way inside Arabic text and is easy to copy.
  const code =
    highlight === undefined
      ? ''
      : `<p style="${CODE}" dir="ltr">${escapeHtml(highlight)}</p>
      `;

  const direction = locale === 'ar' ? 'rtl' : 'ltr';

  return `<!doctype html>
<html lang="${locale}" dir="${direction}">
  <body style="${BODY}">
    <div style="${CARD}" dir="${direction}">
      <h1 style="${H1}">${escapeHtml(title)}</h1>
      ${code}${body}${button}
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
const CODE =
  'margin:0 0 16px;font-size:32px;line-height:1.2;letter-spacing:6px;font-weight:700;color:#18181b;font-family:ui-monospace,monospace;';
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
  return dayWords(at, 'en');
}

function compose(input: {
  to: string;
  subject: string;
  title: string;
  paragraphs: readonly string[];
  action?: Action;
  locale?: EmailLocale;
  /** Shown large above the paragraphs, and first in the text part: a code. */
  highlight?: string;
}): EmailMessage {
  const lines = input.highlight === undefined ? [] : [input.highlight];
  lines.push(...input.paragraphs);
  if (input.action !== undefined) {
    lines.push(`${input.action.label}:`, input.action.url);
  }

  return {
    to: input.to,
    subject: input.subject,
    text: lines.join('\n\n'),
    html: layout(input.title, input.paragraphs, input.action, input.locale, input.highlight),
    ...(input.action === undefined ? {} : { actionUrl: input.action.url }),
    ...(input.highlight === undefined ? {} : { code: input.highlight }),
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
 * A one-time code to sign in with (P36).
 *
 * A code and no link: nothing to open, so no deep-link set-up in the desktop
 * or phone apps, and nothing for a phishing message to imitate with a link of
 * its own. Says how long it lasts and what to do if it was not asked for,
 * because it arrives at an address anybody can type into a sign-in screen.
 */
export function signInCodeEmail(input: {
  to: string;
  code: string;
  minutes: number;
  locale: EmailLocale;
}): EmailMessage {
  const minutes = String(input.minutes);
  return input.locale === 'ar'
    ? compose({
        to: input.to,
        locale: 'ar',
        highlight: input.code,
        subject: `رمز تسجيل الدخول إلى Integr8 Plus: ${input.code}`,
        title: 'رمز تسجيل الدخول',
        paragraphs: [
          'أدخل هذا الرمز في شاشة تسجيل الدخول لتسجيل الدخول إلى Integr8 Plus.',
          `ينتهي الرمز بعد ${minutes} دقيقة، ولا يمكن استخدامه إلا مرة واحدة.`,
          'إذا لم تطلب هذا الرمز، فتجاهل هذه الرسالة. لا يمكن لأحد تسجيل الدخول به دون الوصول إلى بريدك.',
        ],
      })
    : compose({
        to: input.to,
        locale: 'en',
        highlight: input.code,
        subject: `Your Integr8 Plus sign-in code: ${input.code}`,
        title: 'Your sign-in code',
        paragraphs: [
          'Enter this code on the sign-in screen to sign in to Integr8 Plus.',
          `It lasts ${minutes} minutes and works once.`,
          'If you did not ask for this, ignore this email. Nobody can use the code without access to your mailbox.',
        ],
      });
}

/**
 * The password on an account was changed (P36).
 *
 * Sent whoever changed it, because the one person who most needs to hear is
 * the one who did not. Says when, and who to ask: a company user's way back in
 * goes through whoever runs their company, not through us.
 */
export function passwordChangedEmail(input: {
  to: string;
  changedAt: Date;
  locale: EmailLocale;
}): EmailMessage {
  const when = input.changedAt.toISOString().replace('T', ' ').slice(0, 16);
  return input.locale === 'ar'
    ? compose({
        to: input.to,
        locale: 'ar',
        subject: 'تم تغيير كلمة المرور في Integr8 Plus',
        title: 'تم تغيير كلمة المرور',
        paragraphs: [
          `تم تغيير كلمة المرور لحسابك في Integr8 Plus في ${when} (بالتوقيت العالمي UTC).`,
          'تم تسجيل الخروج من جميع أجهزتك الأخرى.',
          'إذا لم تكن أنت من غيّرها، فاطلب المساعدة فورًا من المسؤول عن حساب شركتك.',
        ],
      })
    : compose({
        to: input.to,
        locale: 'en',
        subject: 'Your Integr8 Plus password was changed',
        title: 'Your password was changed',
        paragraphs: [
          `The password for your Integr8 Plus account was changed at ${when} UTC.`,
          'Every other device you were signed in on has been signed out.',
          'If this was not you, ask whoever administers your company for help straight away.',
        ],
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
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = wordsFor(locale).email.dunning;
  const company = { company: input.companyName };
  const paragraphs = input.readOnly
    ? [fill(words.readOnly, company), words.readOnlyKept, words.readOnlyFix]
    : [
        fill(words.failed, company),
        input.deadline === null
          ? words.failedNoDeadline
          : fill(words.failedDeadline, { date: dayWords(input.deadline, locale) }),
        words.failedFix,
      ];

  return compose({
    to: input.to,
    locale,
    subject: fill(input.readOnly ? words.subjectReadOnly : words.subjectFailed, company),
    title: input.readOnly ? words.titleReadOnly : words.titleFailed,
    paragraphs,
    action: { label: words.action, url: input.billingUrl },
  });
}

/** One certificate an expiry alert is about (P26). */
export interface ExpiryItem {
  /** Whose it is; left out of the holder's own message. */
  person?: string;
  qualification: string;
  expiresOn: string;
  stage: 'warning' | 'lapsed';
  /** Planned visits that now lack it, already written in the company's time zone. */
  affectedVisits: readonly string[];
}

/**
 * Certificates that are about to expire, or have (P26).
 *
 * One message per person per day, listing everything: a manager whose team has
 * five certificates lapsing reads one email, not five. The holder's own message
 * says only what is theirs.
 */
export function qualificationExpiryEmail(input: {
  to: string;
  companyName: string;
  items: readonly ExpiryItem[];
  own: boolean;
  url: string | null;
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = wordsFor(locale).email.certificates;
  const company = { company: input.companyName };
  const lapsed = input.items.filter((item) => item.stage === 'lapsed');
  const line = (item: ExpiryItem) => {
    const values = {
      qualification: item.qualification,
      date: calendarDayWords(item.expiresOn, locale),
      person: item.person ?? '',
    };
    const template =
      item.person === undefined
        ? item.stage === 'lapsed'
          ? words.expired
          : words.expiring
        : item.stage === 'lapsed'
          ? words.personExpired
          : words.personExpiring;
    const visits =
      item.affectedVisits.length === 0
        ? ''
        : ` ${fill(words.affectedVisits, { visits: item.affectedVisits.join('; ') })}`;
    return `${fill(template, values)}${visits}`;
  };
  const paragraphs = [
    input.own
      ? fill(lapsed.length > 0 ? words.ownExpired : words.ownExpiring, company)
      : fill(words.team, company),
    ...input.items.map(line),
    input.own ? words.ownNext : words.teamNext,
  ];
  return compose({
    to: input.to,
    locale,
    subject: fill(lapsed.length > 0 ? words.subjectExpired : words.subjectExpiring, company),
    title: lapsed.length > 0 ? words.titleExpired : words.titleExpiring,
    paragraphs,
    ...(input.url === null || input.own ? {} : { action: { label: words.action, url: input.url } }),
  });
}

/** One contract a renewal reminder is about (P27). */
export interface RenewalItem {
  reference: string;
  title: string;
  customer: string;
  endsOn: string;
  stage: 'notice' | 'ended';
}

/**
 * Contracts nearing their end, or ended without being renewed (P27). One
 * message per manager per day, listing every one.
 */
export function contractRenewalEmail(input: {
  to: string;
  companyName: string;
  items: readonly RenewalItem[];
  url: string | null;
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = wordsFor(locale).email.contracts;
  const company = { company: input.companyName };
  const ended = input.items.filter((item) => item.stage === 'ended');
  const line = (item: RenewalItem) =>
    fill(item.stage === 'ended' ? words.ended : words.ending, {
      reference: item.reference,
      title: item.title,
      customer: item.customer,
      date: calendarDayWords(item.endsOn, locale),
    });
  return compose({
    to: input.to,
    locale,
    subject: fill(ended.length > 0 ? words.subjectEnded : words.subjectEnding, company),
    title: ended.length > 0 ? words.titleEnded : words.titleEnding,
    paragraphs: [fill(words.intro, company), ...input.items.map(line), words.next],
    ...(input.url === null ? {} : { action: { label: words.action, url: input.url } }),
  });
}

/** One deadline an alert is about (P27). */
export interface DeadlineItem {
  job: string;
  customer: string;
  kind: 'response' | 'completion';
  /** Already written in the company's time zone. */
  dueAt: string;
  stage: 'warning' | 'missed';
  url: string | null;
}

/**
 * Deadlines about to pass, or passed (P27). One message per person per run,
 * listing every job they should hear about.
 */
export function deadlineAlertEmail(input: {
  to: string;
  companyName: string;
  items: readonly DeadlineItem[];
  url: string | null;
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = wordsFor(locale).email.deadlines;
  const company = { company: input.companyName };
  const missed = input.items.filter((item) => item.stage === 'missed');
  const line = (item: DeadlineItem) => {
    const template =
      item.kind === 'response'
        ? item.stage === 'missed'
          ? words.responseMissed
          : words.responseDue
        : item.stage === 'missed'
          ? words.completionMissed
          : words.completionDue;
    const text = fill(template, { job: item.job, customer: item.customer, when: item.dueAt });
    return item.url === null ? text : `${text} ${item.url}`;
  };
  return compose({
    to: input.to,
    locale,
    subject: fill(missed.length > 0 ? words.subjectMissed : words.subjectDue, company),
    title: missed.length > 0 ? words.titleMissed : words.titleDue,
    paragraphs: [
      fill(missed.length > 0 ? words.introMissed : words.introDue, company),
      ...input.items.map(line),
      words.explained,
    ],
    ...(input.url === null ? {} : { action: { label: words.action, url: input.url } }),
  });
}

/**
 * An admin suspended somebody with HR access (Low 10). The owners hear at
 * once: suspending is the one thing about an HR person an admin may do alone,
 * as an emergency stop, and everything after it is the owner's.
 */
export function hrSuspensionEmail(input: {
  to: string;
  companyName: string;
  /** Who suspended them. */
  admin: string;
  /** Who was suspended. */
  person: string;
  /** Already written in the company's time zone. */
  when: string;
  url: string | null;
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = wordsFor(locale).hrSuspension;
  const values = {
    company: input.companyName,
    admin: input.admin,
    person: input.person,
    date: input.when,
  };
  return compose({
    to: input.to,
    locale,
    subject: fill(words.subject, values),
    title: words.title,
    paragraphs: [fill(words.body, values), fill(words.next, values)],
    ...(input.url === null ? {} : { action: { label: words.action, url: input.url } }),
  });
}

/**
 * A business PDF sent to the customer or supplier it is for (1.3.0): a quote,
 * an invoice, a purchase order or a job report, attached. Written in the
 * language the PDF was made in, so the words and the document agree; the
 * company's own note, if any, is quoted as it was typed.
 */
export function businessDocumentEmail(input: {
  to: string;
  companyName: string;
  /** What the document is, as its own heading says: "Invoice INV-000123". */
  documentTitle: string;
  note: string | null;
  attachment: { filename: string; content: Uint8Array };
  replyTo?: string;
  locale?: EmailLocale;
}): EmailMessage {
  const locale = input.locale ?? 'en';
  const words = (locale === 'ar' ? ar : en).businessPdfs.message;
  const values = { company: input.companyName, document: input.documentTitle };
  const note = input.note?.trim() ?? '';
  const message = compose({
    to: input.to,
    locale,
    subject: fill(words.subject, values),
    title: input.documentTitle,
    paragraphs: [
      fill(words.body, values),
      ...(note === '' ? [] : [fill(words.note, values), note]),
      fill(words.reply, values),
    ],
  });
  return {
    ...message,
    attachments: [
      {
        filename: input.attachment.filename,
        contentType: 'application/pdf',
        content: input.attachment.content,
      },
    ],
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  };
}
