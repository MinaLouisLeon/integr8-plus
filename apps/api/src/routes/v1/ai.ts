import { AI_CHANNELS, AI_LEVELS } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { periodKeysAt, usageView } from '../../ai/periods.js';
import { resolveAiAccess } from '../../ai/policy.js';
import { defineRoute, noSchema } from '../../http/routes.js';

/**
 * The assistant as a member sees it (docs/ai §5.1; ADR-0001).
 *
 * Two reads that work whatever the level, off included: a client has to be
 * able to ask "may I show the assistant" and "how much is left" before it
 * shows anything. Neither names a provider, a key, a budget in money or a
 * colleague. The chat itself arrives in Phase C.
 */

const TAGS = ['ai'];

const usageAxisSchema = z.object({
  used: z.number().int(),
  reserved: z.number().int(),
  limit: z.number().int().nullable(),
  remaining: z.number().int().nullable(),
  resetsAt: z.iso.datetime(),
});

export const aiUsageSchema = z.object({
  /** The company's pooled counters; null on an axis the policy does not limit. */
  daily: usageAxisSchema.nullable(),
  monthly: usageAxisSchema.nullable(),
  /** This member's own counters, limited only when the policy says so. */
  user: z.object({ daily: usageAxisSchema, monthly: usageAxisSchema }),
  unlimited: z.boolean(),
});

export const aiCapabilitiesSchema = z.object({
  /** What this member may use now, after every switch. `off` means show nothing interactive. */
  level: z.enum(AI_LEVELS),
  /** Which switch closed, when `level` is off: for the screen to say why. */
  blockedBy: z
    .enum(['global_off', 'plan_off', 'custom_off', 'not_served', 'channel_off', 'member_off'])
    .nullable(),
  channel: z.enum(AI_CHANNELS),
  /** The tools this member may use at this level; empty until insights ship. */
  tools: z.array(z.string()),
  /** Whether the company's own records may be sent to the provider (insights, actions). */
  companyDataToProvider: z.boolean(),
  locales: z.array(z.enum(['en', 'ar'])),
  /** How many previous turns a conversation keeps in context. */
  historyTurns: z.number().int(),
  allowHistory: z.boolean(),
  usage: aiUsageSchema,
});

export const aiCapabilitiesRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/capabilities',
  operationId: 'getAiCapabilities',
  summary: 'What the assistant may do for the signed-in member',
  description:
    'The level after the plan, the company’s override, the company’s switch for this app (from `x-client-app`) and the member’s own switch. Off is an answer, not an error: the screen hides the assistant or says why it is not included.',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The capabilities.', schema: aiCapabilitiesSchema } },
  handler: async (_input, context) => {
    const access = await resolveAiAccess({
      principal: context.principal,
      clientApp: context.clientApp,
      config: context.config,
    });
    const now = new Date();
    const counters = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiUsage.counters(context.principal.userId, periodKeysAt(now)),
    );
    return {
      status: 200,
      body: {
        level: access.level,
        blockedBy: access.blockedBy,
        channel: access.channel,
        tools: [],
        companyDataToProvider: access.policy.companyDataToProvider,
        locales: ['en', 'ar'],
        historyTurns: context.config.AI_HISTORY_TURNS,
        allowHistory: access.policy.allowHistory,
        usage: usageView(access.policy, counters, now),
      },
    };
  },
});

export const aiUsageRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/usage',
  operationId: 'getAiUsage',
  summary: 'How much of the assistant is left today and this month',
  description:
    'The company’s pooled counters and the member’s own, with the UTC instant each resets. Reserved slots are requests still being answered, and count against what is left.',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The usage.', schema: aiUsageSchema } },
  handler: async (_input, context) => {
    const access = await resolveAiAccess({
      principal: context.principal,
      clientApp: context.clientApp,
      config: context.config,
    });
    const now = new Date();
    const counters = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiUsage.counters(context.principal.userId, periodKeysAt(now)),
    );
    return { status: 200, body: usageView(access.policy, counters, now) };
  },
});

export const aiRoutes = [aiCapabilitiesRoute, aiUsageRoute];
