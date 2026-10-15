import { formatDateTime, formatPercent, useTranslation } from '@integr8/i18n';
import type { AiAllowance } from '../api.js';
import { useOperations } from '../api.js';

/**
 * How much of the member's own share of the assistant is left (ADR-0002 D7).
 *
 * One bar and one sentence, the percentage in words as well as in the bar so
 * nothing depends on colour (docs/ai §10.5). A member is never shown a count
 * of messages or tokens, nor a price: the percentage is of the tightest of
 * whatever the company's plan limits, and the server has already worked out
 * which that is. When nothing is limited there is nothing worth a line.
 */
export function UsageMeter({ allowance }: { allowance: AiAllowance }) {
  const { t } = useTranslation();
  const { locale } = useOperations();
  if (allowance.remainingPercent === null) {
    return null;
  }
  const remaining = Math.min(100, Math.max(0, allowance.remainingPercent));
  const percent = formatPercent(remaining / 100, { locale });
  const time = allowance.resetsAt === null ? null : formatDateTime(allowance.resetsAt, { locale });
  const words = allowance.exhausted
    ? time === null
      ? t('ai.allowance.usedUpShort')
      : t('ai.allowance.usedUpShortResets', { time })
    : time === null
      ? t('ai.allowance.left', { percent })
      : t('ai.allowance.leftResets', { percent, time });

  return (
    <div className="flex max-w-sm flex-col gap-1 text-xs">
      <div
        role="progressbar"
        aria-label={t('ai.allowance.title')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
        aria-valuetext={words}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className={`h-full rounded-full ${
            allowance.exhausted ? 'bg-danger' : remaining <= 20 ? 'bg-warning' : 'bg-accent'
          }`}
          style={{ inlineSize: `${String(remaining)}%` }}
        />
      </div>
      <p className={allowance.exhausted ? 'text-danger' : 'text-content-muted'}>{words}</p>
    </div>
  );
}
