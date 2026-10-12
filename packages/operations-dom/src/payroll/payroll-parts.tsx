import { ApiRequestError } from '@integr8/api-client';
import { hasFeature, toUnits } from '@integr8/core';
import { useTranslation } from '@integr8/i18n';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { keys, type PayRunSummary, useOperations } from '../api.js';
import { Failure } from '../ui.js';

/**
 * Pieces the payroll screens share (seventh round; ADR-0010): who may do
 * what, the refusals the server gives in words of this language, a run's
 * status, the disclaimer every screen and payslip carries, and what an
 * amount, hours or days field accepts.
 *
 * Money is a decimal string from end to end: what is typed is checked as
 * text and sent as text, and what the server calculated is only formatted,
 * never added up here.
 */

/** What this seat may do with the company's payroll. */
export function usePayrollAccess() {
  const { client } = useOperations();
  const me = useQuery({
    queryKey: keys.me,
    queryFn: async () => (await client.GET('/v1/me')).data!,
  });
  const permissions: readonly string[] = me.data?.permissions ?? [];
  // Payroll counts as off without HR, wherever it is asked.
  const enabled = me.data !== undefined && hasFeature(me.data.features, 'payroll');
  return {
    loaded: me.data !== undefined,
    enabled,
    userId: me.data?.userId ?? null,
    owner: me.data?.role === 'owner',
    company: me.data?.company.name ?? null,
    run: enabled && permissions.includes('payroll.run'),
    approve: enabled && permissions.includes('payroll.approve'),
    /** Insurance numbers and bank accounts: the insurance report and the bank file. */
    sensitive: enabled && permissions.includes('hr.sensitive'),
  };
}

/** The code a request was refused with, when it was refused with one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.code : undefined;
}

/**
 * A request the payroll API refused, in words (ADR-0012), with payroll's own
 * wording where a code means more here. `children` adds a way forward, such as
 * a link to the rule sets.
 */
export function PayrollFailure({
  error,
  onRetry,
  children,
}: {
  error: unknown;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Failure
      error={error}
      onRetry={onRetry}
      overrides={{ self_approval: t('payroll.errors.self_approval') }}
    >
      {children}
    </Failure>
  );
}

/**
 * The disclaimer every payroll screen and payslip carries (ADR-0010). The
 * server's own words in English; in another language, the catalogue's
 * translation of them.
 */
export function disclaimerText(server: string, language: string, translated: string): string {
  return language.startsWith('en') ? server : translated;
}

export function Disclaimer({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <aside
      aria-label={t('payroll.disclaimerLabel')}
      className="flex flex-col gap-1 rounded-lg border border-warning bg-warning-subtle p-4 text-start text-sm text-content"
    >
      <p className="font-semibold">{t('payroll.disclaimerLabel')}</p>
      <p>{text}</p>
    </aside>
  );
}

/** Draft or approved, in words, never colour alone. */
export function RunStatusBadge({ status }: { status: PayRunSummary['status'] }) {
  const { t } = useTranslation();
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        status === 'approved'
          ? 'border-success bg-success-subtle text-content'
          : 'border-warning bg-warning-subtle text-content'
      }`}
    >
      {t(`payroll.status.${status}`)}
    </span>
  );
}

/** A short note, such as why a form is not offered. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface-muted p-4 text-start text-sm text-content">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// What fields accept, as the API does
// ---------------------------------------------------------------------------

/** An amount: digits with up to four places, zero allowed. */
export const MONEY_PATTERN = String.raw`\d{1,16}(\.\d{1,4})?`;
export const isMoney = (text: string) => /^\d{1,16}(\.\d{1,4})?$/u.test(text.trim());

/** Hours, such as 12.5. */
export const HOURS_PATTERN = String.raw`\d{1,4}(\.\d{1,2})?`;
export const isHours = (text: string) => /^\d{1,4}(\.\d{1,2})?$/u.test(text.trim());

/** Unpaid days in a month: at most thirty, to two places. */
export const DAYS_PATTERN = String.raw`\d{1,2}(\.\d{1,2})?`;
export function isDays(text: string): boolean {
  const value = text.trim();
  return /^\d{1,2}(\.\d{1,2})?$/u.test(value) && toUnits(value) <= toUnits('30');
}

/** Today in the reader's own calendar, as the API writes a date. */
export function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Hours or days as the reader's language writes a number, exactly as given. */
export function formatQuantity(value: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
      value as unknown as number,
    );
  } catch {
    return value;
  }
}

/** The payslip languages: Egyptian payslips are often wanted in Arabic whatever the office reads. */
export const PAYSLIP_LANGUAGES = ['en', 'ar'] as const;
export type PayslipLanguage = (typeof PAYSLIP_LANGUAGES)[number];

export const languageOf = (locale: string): PayslipLanguage =>
  locale.startsWith('ar') ? 'ar' : 'en';
