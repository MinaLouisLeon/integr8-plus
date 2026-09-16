'use client';

import { useTranslation } from '@integr8/i18n';
import type { ReactNode } from 'react';
import { formatDate } from '~/lib/platform-format';

/**
 * The few small pieces every dashboard screen needs (P15).
 *
 * Not a design system. Three components that would otherwise be copied into
 * six screens and drift.
 */

/**
 * A company's status, at a glance.
 *
 * A scheduled closure wins over the status behind it: a company that is
 * suspended *because it is being closed on Friday* is a different situation
 * from one suspended for an unpaid invoice, and the first is the one somebody
 * needs to notice.
 */
export function StatusBadge({
  status,
  deletionScheduledFor,
}: {
  status: 'active' | 'suspended' | 'cancelled';
  deletionScheduledFor?: string | null;
}) {
  const { t } = useTranslation();

  if (deletionScheduledFor !== null && deletionScheduledFor !== undefined) {
    return (
      <Badge tone="danger">
        {t('platform.companies.deletionScheduled', { when: formatDate(deletionScheduledFor) })}
      </Badge>
    );
  }

  if (status === 'suspended') {
    return <Badge tone="warning">{t('platform.companies.statusSuspended')}</Badge>;
  }
  if (status === 'cancelled') {
    return <Badge tone="muted">{t('platform.companies.statusCancelled')}</Badge>;
  }
  return <Badge tone="ok">{t('platform.companies.statusActive')}</Badge>;
}

const TONES = {
  ok: 'bg-success-subtle text-success',
  warning: 'bg-warning-subtle text-warning',
  danger: 'bg-danger-subtle text-danger',
  muted: 'bg-surface-muted text-content-muted',
} as const;

export function Badge({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A titled block, so every screen's sections look like sections. */
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border-subtle p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold text-content">{title}</h2>
          {description === undefined ? null : (
            <p className="text-sm text-content-muted">{description}</p>
          )}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}
