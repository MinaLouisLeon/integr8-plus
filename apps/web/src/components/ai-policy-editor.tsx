'use client';

import {
  AI_LEVELS,
  AI_QUOTA_MODES,
  quotaModeHasDaily,
  quotaModeHasMonthly,
  type AiLevel,
  type AiPolicy,
  type AiQuotaMode,
} from '@integr8/core';
import { formatCurrency, useTranslation, type TFunction } from '@integr8/i18n';
import { useId } from 'react';
import { Field } from '~/components/ui';

/**
 * The assistant policy editor, shared by the plans page and a company's page
 * (ADR-0001 D1/D6).
 *
 * The same fourteen fields are set in two places — once per plan, once per
 * company that departs from its plan — and the consistency rule between them
 * (an enabled level needs a quota mode and the limits that mode names, or
 * unlimited messages with a cost cap) is the API's. It is checked here too, so
 * a form says what is missing before a 422 does, but the API's answer wins.
 *
 * Money is edited in whole dollars and sent in micros. The one conversion is
 * `Math.round(Number(usd) * 1_000_000)`; nothing else here does arithmetic on
 * an amount.
 */

export type AiPolicyFields = AiPolicy;

const SELECT_CLASS = 'rounded-md border border-border-subtle bg-surface px-3 py-2 text-content';

/** What the form holds: strings, because an input is a string until it is saved. */
export interface AiPolicyDraft {
  level: AiLevel;
  quotaMode: AiQuotaMode;
  dailyLimit: string;
  monthlyLimit: string;
  perUserDailyLimit: string;
  perUserMonthlyLimit: string;
  unlimitedMessages: boolean;
  monthlyCostCapUsd: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  maxToolSteps: string;
  maxProviderCalls: string;
  allowHistory: boolean;
  retentionDays: string;
}

export function draftFromPolicy(policy: AiPolicyFields): AiPolicyDraft {
  return {
    level: policy.level,
    quotaMode: policy.quotaMode ?? 'monthly',
    dailyLimit: policy.dailyLimit === null ? '' : String(policy.dailyLimit),
    monthlyLimit: policy.monthlyLimit === null ? '' : String(policy.monthlyLimit),
    perUserDailyLimit: policy.perUserDailyLimit === null ? '' : String(policy.perUserDailyLimit),
    perUserMonthlyLimit:
      policy.perUserMonthlyLimit === null ? '' : String(policy.perUserMonthlyLimit),
    unlimitedMessages: policy.unlimitedMessages,
    monthlyCostCapUsd:
      policy.monthlyCostCapMicrousd === null
        ? ''
        : (policy.monthlyCostCapMicrousd / 1_000_000).toFixed(2),
    maxInputTokens: String(policy.maxInputTokens),
    maxOutputTokens: String(policy.maxOutputTokens),
    maxToolSteps: String(policy.maxToolSteps),
    maxProviderCalls: String(policy.maxProviderCalls),
    allowHistory: policy.allowHistory,
    retentionDays: String(policy.retentionDays),
  };
}

/** Only the policy's own fields, from a record that carries more (a version, a source). */
export function pickPolicyFields(policy: AiPolicyFields): AiPolicyFields {
  return {
    level: policy.level,
    quotaMode: policy.quotaMode,
    dailyLimit: policy.dailyLimit,
    monthlyLimit: policy.monthlyLimit,
    perUserDailyLimit: policy.perUserDailyLimit,
    perUserMonthlyLimit: policy.perUserMonthlyLimit,
    unlimitedMessages: policy.unlimitedMessages,
    monthlyCostCapMicrousd: policy.monthlyCostCapMicrousd,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
    maxToolSteps: policy.maxToolSteps,
    maxProviderCalls: policy.maxProviderCalls,
    allowHistory: policy.allowHistory,
    retentionDays: policy.retentionDays,
  };
}

function intOrNull(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

/** The policy as the API takes it. The quota mode is only sent when it applies. */
export function policyFromDraft(draft: AiPolicyDraft): AiPolicyFields {
  const quotaApplies = draft.level !== 'off' && !draft.unlimitedMessages;
  const quotaMode = quotaApplies ? draft.quotaMode : null;
  return {
    level: draft.level,
    quotaMode,
    dailyLimit: quotaModeHasDaily(quotaMode) ? intOrNull(draft.dailyLimit) : null,
    monthlyLimit: quotaModeHasMonthly(quotaMode) ? intOrNull(draft.monthlyLimit) : null,
    perUserDailyLimit: intOrNull(draft.perUserDailyLimit),
    perUserMonthlyLimit: intOrNull(draft.perUserMonthlyLimit),
    unlimitedMessages: draft.unlimitedMessages,
    monthlyCostCapMicrousd:
      draft.monthlyCostCapUsd.trim() === ''
        ? null
        : Math.round(Number(draft.monthlyCostCapUsd) * 1_000_000),
    maxInputTokens: Number(draft.maxInputTokens),
    maxOutputTokens: Number(draft.maxOutputTokens),
    maxToolSteps: Number(draft.maxToolSteps),
    maxProviderCalls: Number(draft.maxProviderCalls),
    allowHistory: draft.allowHistory,
    retentionDays: Number(draft.retentionDays),
  };
}

export type AiDraftProblems = Partial<
  Record<'quotaMode' | 'dailyLimit' | 'monthlyLimit' | 'monthlyCostCapUsd', string>
>;

/**
 * The consistency rule, as words beside the field that breaks it.
 *
 * Mirrors `aiPolicySchema` in `@integr8/core`: a level other than off needs
 * either a quota mode with the limits it names, or unlimited messages with a
 * monthly cost cap.
 */
export function draftProblems(draft: AiPolicyDraft, t: TFunction): AiDraftProblems {
  if (draft.level === 'off') {
    return {};
  }
  if (draft.unlimitedMessages) {
    return draft.monthlyCostCapUsd.trim() === ''
      ? { monthlyCostCapUsd: t('platform.ai.capRequired') }
      : {};
  }
  const problems: AiDraftProblems = {};
  if (quotaModeHasDaily(draft.quotaMode) && draft.dailyLimit.trim() === '') {
    problems.dailyLimit = t('platform.ai.limitRequired');
  }
  if (quotaModeHasMonthly(draft.quotaMode) && draft.monthlyLimit.trim() === '') {
    problems.monthlyLimit = t('platform.ai.limitRequired');
  }
  return problems;
}

export function draftIsValid(draft: AiPolicyDraft, t: TFunction): boolean {
  return Object.keys(draftProblems(draft, t)).length === 0;
}

export function levelLabel(t: TFunction, level: AiLevel): string {
  switch (level) {
    case 'off':
      return t('platform.ai.levelOff');
    case 'help':
      return t('platform.ai.levelHelp');
    case 'insights':
      return t('platform.ai.levelInsights');
    case 'agent':
      return t('platform.ai.levelAgent');
  }
}

export function quotaModeLabel(t: TFunction, mode: AiQuotaMode | null): string {
  switch (mode) {
    case 'daily':
      return t('platform.ai.quotaDaily');
    case 'monthly':
      return t('platform.ai.quotaMonthly');
    case 'daily_and_monthly':
      return t('platform.ai.quotaDailyAndMonthly');
    case null:
      return t('platform.ai.quotaNone');
  }
}

/** USD micros as money. 1 USD = 1,000,000 micros. */
export function formatMicrousd(micros: number, locale: string): string {
  return formatCurrency(micros / 1_000_000, 'USD', { locale });
}

/** The policy, read-only, as a definition list. */
export function AiPolicySummary({ policy }: { policy: AiPolicyFields }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const none = t('platform.ai.noLimit');

  const perUserParts: string[] = [];
  if (policy.perUserDailyLimit !== null) {
    perUserParts.push(t('platform.ai.perDay', { n: policy.perUserDailyLimit }));
  }
  if (policy.perUserMonthlyLimit !== null) {
    perUserParts.push(t('platform.ai.perMonth', { n: policy.perUserMonthlyLimit }));
  }
  const perUser = perUserParts.length === 0 ? none : perUserParts.join(' · ');

  const quotaParts: string[] = [];
  if (!policy.unlimitedMessages && policy.quotaMode !== null) {
    quotaParts.push(quotaModeLabel(t, policy.quotaMode));
    if (policy.dailyLimit !== null) {
      quotaParts.push(t('platform.ai.perDay', { n: policy.dailyLimit }));
    }
    if (policy.monthlyLimit !== null) {
      quotaParts.push(t('platform.ai.perMonth', { n: policy.monthlyLimit }));
    }
  }
  const quota = policy.unlimitedMessages
    ? t('platform.ai.unlimitedMessages')
    : policy.quotaMode === null
      ? quotaModeLabel(t, null)
      : quotaParts.join(' · ');

  return (
    <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
      <SummaryFact label={t('platform.ai.level')} value={levelLabel(t, policy.level)} />
      <SummaryFact label={t('platform.ai.quota')} value={quota} />
      <SummaryFact label={t('platform.ai.perUser')} value={perUser} />
      <SummaryFact
        label={t('platform.ai.monthlyCostCap')}
        value={
          policy.monthlyCostCapMicrousd === null
            ? t('platform.ai.noCap')
            : formatMicrousd(policy.monthlyCostCapMicrousd, locale)
        }
      />
      <SummaryFact
        label={t('platform.ai.tokens')}
        value={t('platform.ai.tokensValue', {
          input: policy.maxInputTokens,
          output: policy.maxOutputTokens,
        })}
      />
      <SummaryFact label={t('platform.ai.maxProviderCalls')} value={policy.maxProviderCalls} />
      <SummaryFact label={t('platform.ai.maxToolSteps')} value={policy.maxToolSteps} />
      <SummaryFact
        label={t('platform.ai.retention')}
        value={
          policy.allowHistory
            ? t('platform.ai.retentionValue', { n: policy.retentionDays })
            : t('platform.ai.historyOff')
        }
      />
    </dl>
  );
}

function SummaryFact({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-content-muted">{label}</dt>
      <dd className="font-medium text-content">{value}</dd>
    </div>
  );
}

/**
 * The fields. Stateless: the page owns the draft, because the page owns the
 * save, the version it read and what to do with a 409.
 */
export function AiPolicyEditor({
  draft,
  onChange,
  disabled = false,
}: {
  draft: AiPolicyDraft;
  onChange: (next: AiPolicyDraft) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const problems = draftProblems(draft, t);
  const set = <Key extends keyof AiPolicyDraft>(key: Key, value: AiPolicyDraft[Key]) => {
    onChange({ ...draft, [key]: value });
  };

  const enabled = draft.level !== 'off';
  const quotaApplies = enabled && !draft.unlimitedMessages;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-content">{t('platform.ai.level')}</span>
          <select
            value={draft.level}
            disabled={disabled}
            onChange={(event) => set('level', event.target.value as AiLevel)}
            className={SELECT_CLASS}
          >
            {AI_LEVELS.map((level) => (
              <option key={level} value={level}>
                {levelLabel(t, level)}
              </option>
            ))}
          </select>
          <span className="text-xs text-content-muted">{t('platform.ai.levelHint')}</span>
        </label>

        {enabled ? (
          <div className="flex items-start gap-2 pt-6 text-sm">
            <input
              id={`${id}-unlimited`}
              type="checkbox"
              className="mt-1"
              aria-describedby={`${id}-unlimited-hint`}
              disabled={disabled}
              checked={draft.unlimitedMessages}
              onChange={(event) => set('unlimitedMessages', event.target.checked)}
            />
            <div className="flex flex-col gap-0.5">
              <label htmlFor={`${id}-unlimited`} className="font-medium text-content">
                {t('platform.ai.unlimitedMessages')}
              </label>
              <p id={`${id}-unlimited-hint`} className="text-xs text-content-muted">
                {t('platform.ai.unlimitedMessagesHint')}
              </p>
            </div>
          </div>
        ) : null}

        {quotaApplies ? (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-content">{t('platform.ai.quotaMode')}</span>
              <select
                value={draft.quotaMode}
                disabled={disabled}
                onChange={(event) => set('quotaMode', event.target.value as AiQuotaMode)}
                className={SELECT_CLASS}
              >
                {AI_QUOTA_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {quotaModeLabel(t, mode)}
                  </option>
                ))}
              </select>
              {problems.quotaMode === undefined ? null : (
                <span role="alert" className="text-xs text-danger">
                  {problems.quotaMode}
                </span>
              )}
            </label>
            {quotaModeHasDaily(draft.quotaMode) ? (
              <Field
                label={t('platform.ai.dailyLimit')}
                type="number"
                min={1}
                required
                disabled={disabled}
                value={draft.dailyLimit}
                onChange={(event) => set('dailyLimit', event.target.value)}
                error={problems.dailyLimit}
              />
            ) : null}
            {quotaModeHasMonthly(draft.quotaMode) ? (
              <Field
                label={t('platform.ai.monthlyLimit')}
                type="number"
                min={1}
                required
                disabled={disabled}
                value={draft.monthlyLimit}
                onChange={(event) => set('monthlyLimit', event.target.value)}
                error={problems.monthlyLimit}
              />
            ) : null}
          </>
        ) : null}

        {enabled ? (
          <>
            <Field
              label={t('platform.ai.perUserDailyLimit')}
              hint={t('platform.ai.perUserHint')}
              type="number"
              min={1}
              disabled={disabled}
              value={draft.perUserDailyLimit}
              onChange={(event) => set('perUserDailyLimit', event.target.value)}
            />
            <Field
              label={t('platform.ai.perUserMonthlyLimit')}
              hint={t('platform.ai.perUserHint')}
              type="number"
              min={1}
              disabled={disabled}
              value={draft.perUserMonthlyLimit}
              onChange={(event) => set('perUserMonthlyLimit', event.target.value)}
            />
          </>
        ) : null}

        <Field
          label={t('platform.ai.monthlyCostCap')}
          hint={
            draft.unlimitedMessages
              ? t('platform.ai.monthlyCostCapRequiredHint')
              : t('platform.ai.monthlyCostCapHint')
          }
          type="number"
          min={0.01}
          step="0.01"
          required={draft.unlimitedMessages}
          disabled={disabled}
          value={draft.monthlyCostCapUsd}
          onChange={(event) => set('monthlyCostCapUsd', event.target.value)}
          error={problems.monthlyCostCapUsd}
        />
        <Field
          label={t('platform.ai.maxInputTokens')}
          type="number"
          min={1}
          required
          disabled={disabled}
          value={draft.maxInputTokens}
          onChange={(event) => set('maxInputTokens', event.target.value)}
        />
        <Field
          label={t('platform.ai.maxOutputTokens')}
          type="number"
          min={1}
          required
          disabled={disabled}
          value={draft.maxOutputTokens}
          onChange={(event) => set('maxOutputTokens', event.target.value)}
        />
        <Field
          label={t('platform.ai.maxProviderCalls')}
          type="number"
          min={1}
          required
          disabled={disabled}
          value={draft.maxProviderCalls}
          onChange={(event) => set('maxProviderCalls', event.target.value)}
        />
        <Field
          label={t('platform.ai.maxToolSteps')}
          type="number"
          min={1}
          required
          disabled={disabled}
          value={draft.maxToolSteps}
          onChange={(event) => set('maxToolSteps', event.target.value)}
        />
        <Field
          label={t('platform.ai.retentionDays')}
          hint={t('platform.ai.retentionHint')}
          type="number"
          min={1}
          max={3650}
          required
          disabled={disabled}
          value={draft.retentionDays}
          onChange={(event) => set('retentionDays', event.target.value)}
        />
        <div className="flex items-start gap-2 pt-6 text-sm">
          <input
            id={`${id}-history`}
            type="checkbox"
            className="mt-1"
            aria-describedby={`${id}-history-hint`}
            disabled={disabled}
            checked={draft.allowHistory}
            onChange={(event) => set('allowHistory', event.target.checked)}
          />
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${id}-history`} className="font-medium text-content">
              {t('platform.ai.allowHistory')}
            </label>
            <p id={`${id}-history-hint`} className="text-xs text-content-muted">
              {t('platform.ai.allowHistoryHint')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
