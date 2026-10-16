import { AI_ANSWER_SOURCES, roleRank, toUserId } from '@integr8/core';
import {
  AiMemberLimitsVersionConflictError,
  AiSharesOverTotalError,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { aiMemberLimitsChanged, aiSharesOverTotal } from '../../ai/errors.js';
import { forgetAiPolicy, resolveEffectiveAiPolicy } from '../../ai/policy.js';
import {
  companyAllowance,
  libraryAllowance,
  memberAllowance,
  periodKeysAt,
} from '../../ai/periods.js';
import { forbidden, notFound } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { aiAllowanceSchema } from './ai.js';

/**
 * How a company divides its assistant allowance among its people
 * (docs/ai/ADR-0002 D6, D7).
 *
 * Owners and admins (`member.update_role`) give each member a whole
 * percentage of the company's allowance; the shares are reserved slices and
 * total 100 or less. A member with no share has no model answers; library
 * answers need no share, so while a company is answered from the library
 * every allowance shown is the company's (ADR-0002 D10). Nothing here
 * carries a token count, a message count or a price: the company sees
 * percentages, and the platform alone sees the numbers behind them.
 */

const TAGS = ['ai'];

const shareRowSchema = z.object({
  userId: z.uuid(),
  displayName: z.string(),
  /** The member's own switch, as `PATCH /v1/members/:userId/ai` sets it. */
  aiEnabled: z.boolean(),
  /** 1–100, or null: no share, so no assistant. */
  sharePercent: z.number().int().nullable(),
  /** The row's version for `expectedVersion`; null when the member never had a share. */
  version: z.number().int().nullable(),
  /** What is left of this member's share. */
  allowance: aiAllowanceSchema,
});

const sharesSchema = z.object({
  company: z.object({
    allowance: aiAllowanceSchema,
    assignedPercent: z.number().int(),
    /**
     * Where the company's answers come from now. Under `library` shares are
     * kept but decide nothing until answers come from a model again.
     */
    answerSource: z.enum(AI_ANSWER_SOURCES),
  }),
  items: z.array(shareRowSchema),
});

export const listAiSharesRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/shares',
  operationId: 'listAiShares',
  summary: 'How the company’s assistant allowance is divided among its people',
  description:
    'Every active member with their share, as a whole percentage of the company’s allowance, and what is left of it; and the company’s own. Percentages only (ADR-0002).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The shares.', schema: sharesSchema } },
  handler: async (_input, context) => {
    const tenantId = context.principal.tenantId;
    const policy = await resolveEffectiveAiPolicy(tenantId, context.config);
    const now = new Date();
    const periods = periodKeysAt(now);
    const { members, limits, counters, companyMessages, companyTokens, assigned } =
      await withTenant(tenantId, async (tx) => ({
        members: await tx.tenantUsers.list(),
        limits: await tx.aiMemberLimits.list(),
        counters: await tx.aiUsage.memberCounters(periods),
        companyMessages: await tx.aiUsage.counters(context.principal.userId, periods),
        companyTokens: await tx.aiUsage.tokenCounters(context.principal.userId, periods),
        assigned: await tx.aiMemberLimits.assignedPercent(),
      }));

    const library = policy.answersFrom === 'library';
    const companyLeft = library
      ? libraryAllowance({ policy, messages: companyMessages, now })
      : companyAllowance({ policy, messages: companyMessages, tokens: companyTokens, now });
    const items = members
      .filter((member) => member.status === 'active')
      .map((member) => {
        const limit = limits.find((row) => row.userId === member.userId);
        const own = counters.filter((row) => row.userId === member.userId);
        const asCounters = (kind: 'messages' | 'tokens') =>
          own.map((row) => ({
            subject: 'user' as const,
            period: row.period,
            periodStart: row.period === 'day' ? periods.day : periods.month,
            used: kind === 'messages' ? row.messagesUsed : row.tokensUsed,
            reserved: kind === 'messages' ? row.messagesReserved : row.tokensReserved,
          }));
        return {
          userId: member.userId,
          displayName: member.displayName,
          aiEnabled: member.aiEnabled,
          sharePercent: limit?.sharePercent ?? null,
          version: limit?.version ?? null,
          allowance: library
            ? companyLeft
            : memberAllowance({
                policy,
                sharePercent: limit?.sharePercent ?? null,
                messages: asCounters('messages'),
                tokens: asCounters('tokens'),
                now,
              }),
        };
      });

    return {
      status: 200,
      body: {
        company: {
          allowance: companyLeft,
          assignedPercent: assigned,
          answerSource: policy.answersFrom,
        },
        items,
      },
    };
  },
});

export const setAiShareRoute = defineRoute({
  method: 'put',
  path: '/v1/ai/shares/:userId',
  operationId: 'setAiShare',
  summary: 'Give a member a share of the company’s assistant allowance, or take it away',
  description:
    '`sharePercent` is a whole percentage, 1–100, of every company allowance, reserved for this member; null takes it away, and with it the assistant. The company’s shares total 100 or less (422 `ai_shares_over_total`, with what is still unassigned). `expectedVersion` is the version last read, or null for a member who never had a share (409 `ai_member_limits_changed` otherwise). Owners and admins set it, for members they outrank. Counters are never touched: lowering a share below what was used this period refuses further questions until it resets.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'member.update_role',
  params: z.object({ userId: z.uuid() }),
  query: noSchema,
  body: z.object({
    sharePercent: z.number().int().min(1).max(100).nullable(),
    expectedVersion: z.number().int().positive().nullable(),
  }),
  responses: {
    200: { description: 'The member’s share as it now is.', schema: shareRowSchema },
    404: { description: 'No such person in this company.' },
    409: { description: 'Somebody changed it first (`ai_member_limits_changed`).' },
    422: { description: 'The shares would pass 100% (`ai_shares_over_total`).' },
  },
  handler: async ({ params, body }, context) => {
    const tenantId = context.principal.tenantId;
    const target = await withTenant(tenantId, (tx) =>
      tx.tenantUsers.findByUserId(toUserId(params.userId)),
    );
    if (target === undefined) {
      throw notFound('No such person in this company.');
    }
    if (
      params.userId !== context.principal.userId &&
      roleRank(target.role) > roleRank(context.principal.role)
    ) {
      throw forbidden(
        'You cannot change the assistant share of somebody whose role is above your own.',
      );
    }

    let saved;
    try {
      saved = await withTenant(tenantId, async (tx) => {
        const before = await tx.aiMemberLimits.find(params.userId);
        const limits = await tx.aiMemberLimits.set({
          userId: params.userId,
          sharePercent: body.sharePercent,
          expectedVersion: body.expectedVersion,
          updatedBy: context.principal.userId,
        });
        await tx.auditLog.append({
          actorKind: 'tenant_user',
          actorId: context.principal.userId,
          actorLabel: context.principal.userId,
          action: 'member.ai_share_changed',
          resourceType: 'tenant_user',
          resourceId: params.userId,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            before: before?.sharePercent ?? null,
            after: limits.sharePercent,
          },
        });
        return limits;
      });
    } catch (error) {
      if (error instanceof AiMemberLimitsVersionConflictError) {
        throw aiMemberLimitsChanged(error.currentVersion);
      }
      if (error instanceof AiSharesOverTotalError) {
        throw aiSharesOverTotal(error.availablePercent);
      }
      throw error;
    }
    forgetAiPolicy(tenantId);

    const policy = await resolveEffectiveAiPolicy(tenantId, context.config);
    const now = new Date();
    const periods = periodKeysAt(now);
    const { messages, tokens } = await withTenant(tenantId, async (tx) => ({
      messages: await tx.aiUsage.counters(params.userId, periods),
      tokens: await tx.aiUsage.tokenCounters(params.userId, periods),
    }));
    return {
      status: 200,
      body: {
        userId: target.userId,
        displayName: target.displayName,
        aiEnabled: target.aiEnabled,
        sharePercent: saved.sharePercent,
        version: saved.version,
        allowance:
          policy.answersFrom === 'library'
            ? libraryAllowance({ policy, messages, now })
            : memberAllowance({
                policy,
                sharePercent: saved.sharePercent,
                messages,
                tokens,
                now,
              }),
      },
    };
  },
});

export const aiShareRoutes = [listAiSharesRoute, setAiShareRoute];
