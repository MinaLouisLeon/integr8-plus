import type { AiLevel, AiPeriodType } from '@integr8/core';
import { ApiError } from '../http/errors.js';

/**
 * The assistant's refusals (docs/ai §5.3; ADR-0001), each with the stable
 * code the catalogue translates. The messages are for a log; the screens show
 * the catalogue's words for the code.
 */

export const aiDisabled = (reason: string) =>
  new ApiError(403, 'ai_disabled', `The assistant is not available: ${reason}.`);

export const aiLevelRequired = (required: AiLevel) =>
  new ApiError(
    403,
    'ai_level_required',
    `This needs the ${required} level, which this company's plan does not include.`,
  );

export const aiToolForbidden = (tool: string) =>
  new ApiError(403, 'ai_tool_forbidden', `This seat may not use the ${tool} tool.`);

export const aiConversationNotFound = () =>
  new ApiError(404, 'ai_conversation_not_found', 'No such conversation.');

export const aiRequestInProgress = () =>
  new ApiError(
    409,
    'ai_request_in_progress',
    'This question is still being answered. Wait for the answer rather than sending it again.',
  );

export const aiActionExpired = () =>
  new ApiError(
    409,
    'ai_action_expired',
    'This proposal has expired or the record it concerns has changed. Ask again for a fresh one.',
  );

export const aiActionAlreadyExecuted = () =>
  new ApiError(409, 'ai_action_already_executed', 'This action has already been carried out.');

export const aiQuotaExceeded = (axis: AiPeriodType, resetsAt: Date) => {
  const code = axis === 'day' ? 'ai_daily_quota_exceeded' : 'ai_monthly_quota_exceeded';
  return new ApiError(
    429,
    code,
    axis === 'day'
      ? 'Today’s assistant messages are used up.'
      : 'This month’s assistant messages are used up.',
    [
      {
        field: 'body.message',
        code,
        message: 'No messages left.',
        params: { resetsAt: resetsAt.toISOString() },
      },
    ],
    { 'retry-after': String(Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000))) },
  );
};

/**
 * The next model call would not fit in the company's or the member's token
 * allowance (ADR-0002 D5). Says when it resets, never how many tokens.
 */
export const aiTokenQuotaExceeded = (axis: AiPeriodType, resetsAt: Date) => {
  const code = axis === 'day' ? 'ai_daily_token_quota_exceeded' : 'ai_monthly_token_quota_exceeded';
  return new ApiError(
    429,
    code,
    axis === 'day'
      ? 'Today’s assistant allowance is used up.'
      : 'This month’s assistant allowance is used up.',
    [
      {
        field: 'body.message',
        code,
        message: 'No allowance left.',
        params: { resetsAt: resetsAt.toISOString() },
      },
    ],
    { 'retry-after': String(Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000))) },
  );
};

/**
 * The member's own monthly dollar cap, set by the platform, is used up
 * (ADR-0002 D7). The amount is never in the answer.
 */
export const aiMemberBudgetExceeded = (resetsAt: Date) =>
  new ApiError(
    429,
    'ai_member_budget_exceeded',
    'Your assistant allowance for this month is used up.',
    [
      {
        field: 'body.message',
        code: 'ai_member_budget_exceeded',
        message: 'No allowance left this month.',
        params: { resetsAt: resetsAt.toISOString() },
      },
    ],
    { 'retry-after': String(Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1000))) },
  );

/** A member's share or cap changed since it was read (ADR-0002 D6). */
export const aiMemberLimitsChanged = (currentVersion: number | null) =>
  new ApiError(
    409,
    'ai_member_limits_changed',
    `This member's assistant share changed (now version ${String(currentVersion)}); read it again before saving.`,
  );

/** The company's shares would total more than 100% (ADR-0002 D6). */
export const aiSharesOverTotal = (availablePercent: number) =>
  new ApiError(
    422,
    'ai_shares_over_total',
    `Only ${String(availablePercent)}% of the company's allowance is unassigned.`,
    [
      {
        field: 'body.sharePercent',
        code: 'ai_shares_over_total',
        message: 'The shares would total more than 100%.',
        params: { availablePercent: String(availablePercent) },
      },
    ],
  );

export const aiConcurrencyLimit = () =>
  new ApiError(
    429,
    'ai_concurrency_limit',
    'Too many questions are being answered at once. Wait for one to finish.',
    undefined,
    { 'retry-after': '5' },
  );

export const aiProviderUnavailable = (retryAfterSeconds = 30) =>
  new ApiError(
    503,
    'ai_provider_unavailable',
    'The assistant could not reach its model. Try again in a moment.',
    undefined,
    { 'retry-after': String(retryAfterSeconds) },
  );

export const aiBudgetUnavailable = () =>
  new ApiError(
    503,
    'ai_budget_unavailable',
    'The assistant is paused for now. Try again later.',
    undefined,
    { 'retry-after': '3600' },
  );

export const aiValidationFailed = (message: string, field = 'body') =>
  new ApiError(422, 'ai_validation_failed', message, [
    { field, code: 'ai_validation_failed', message },
  ]);
