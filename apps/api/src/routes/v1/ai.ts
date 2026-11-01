import {
  AI_ANSWER_SOURCES,
  AI_CHANNELS,
  AI_LEVELS,
  AI_PROPOSAL_STATES,
  aiSourceRefSchema,
  aiToolSummarySchema,
  holds,
  type Principal,
} from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import {
  answerMessage,
  assertAiLevel,
  MAX_MESSAGE_CHARS,
  offeredToolKeys,
  toOutputMessage,
  withProposal,
} from '../../ai/chat.js';
import { ACTION_CATALOGUE } from '../../ai/actions/catalogue.js';
import { confirmProposal, getProposal, rejectProposal } from '../../ai/actions/service.js';
import { aiConversationNotFound } from '../../ai/errors.js';
import {
  companyAllowance,
  libraryAllowance,
  memberAllowance,
  periodKeysAt,
} from '../../ai/periods.js';
import { type AiAccess, resolveAiAccess, sessionClientApp } from '../../ai/policy.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { iso } from './schemas.js';

/**
 * The assistant as a member sees it (docs/ai §5.1; ADR-0001).
 *
 * Two reads that work whatever the level, off included: a client has to be
 * able to ask "may I show the assistant" and "how much is left" before it
 * shows anything. Neither names a provider, a key, a budget in money or a
 * colleague. The chat itself arrives in Phase C.
 */

const TAGS = ['ai'];

/**
 * How much of an allowance is left, as a company or a member is shown it
 * (ADR-0002 D7): a whole percentage of the tightest limited axis, messages
 * and tokens, day and month, and when that axis resets. Never the counts or
 * the money behind it.
 */
export const aiAllowanceSchema = z.object({
  /** 0–100; null when nothing is limited. */
  remainingPercent: z.number().int().nullable(),
  resetsAt: z.iso.datetime().nullable(),
  /** True when a question would be refused now. */
  exhausted: z.boolean(),
});

export const aiUsageSchema = z.object({
  /** What is left of this member's own share. */
  allowance: aiAllowanceSchema,
  /** This member's percentage of the company's allowance; null is none (no assistant). */
  sharePercent: z.number().int().nullable(),
  /**
   * The whole company's allowance and how much of it is assigned: for those
   * who assign shares (`member.update_role`) only; null for everybody else.
   */
  company: z.object({ allowance: aiAllowanceSchema, assignedPercent: z.number().int() }).nullable(),
});

/**
 * What a member, and an owner, is told about what is left (ADR-0002 D6, D7).
 * When answers come from the library, member and company alike see the
 * company's messages left: nobody holds a share of what costs nothing (D10).
 */
async function usageOf(principal: Principal, access: AiAccess, now: Date) {
  const periods = periodKeysAt(now);
  const owner = holds(principal, 'member.update_role');
  const { messages, tokens, assigned } = await withTenant(principal.tenantId, async (tx) => ({
    messages: await tx.aiUsage.counters(principal.userId, periods),
    tokens: await tx.aiUsage.tokenCounters(principal.userId, periods),
    assigned: owner ? await tx.aiMemberLimits.assignedPercent() : 0,
  }));
  if (access.policy.answersFrom === 'library') {
    const allowance = libraryAllowance({ policy: access.policy, messages, now });
    return {
      allowance,
      sharePercent: access.sharePercent,
      company: owner ? { allowance, assignedPercent: assigned } : null,
    };
  }
  return {
    allowance: memberAllowance({
      policy: access.policy,
      sharePercent: access.sharePercent,
      messages,
      tokens,
      now,
    }),
    sharePercent: access.sharePercent,
    company: owner
      ? {
          allowance: companyAllowance({ policy: access.policy, messages, tokens, now }),
          assignedPercent: assigned,
        }
      : null,
  };
}

export const aiCapabilitiesSchema = z.object({
  /** What this member may use now, after every switch. `off` means show nothing interactive. */
  level: z.enum(AI_LEVELS),
  /** Which switch closed, when `level` is off: for the screen to say why. */
  blockedBy: z
    .enum([
      'global_off',
      'plan_off',
      'custom_off',
      'not_served',
      'provider_unconfigured',
      'channel_off',
      'member_off',
      'no_share',
    ])
    .nullable(),
  channel: z.enum(AI_CHANNELS),
  /**
   * Where answers come from now (ADR-0002 D9–D12): a model, or the help
   * library, which answers Help questions with the articles it holds and
   * needs no share.
   */
  answerSource: z.enum(AI_ANSWER_SOURCES),
  /** The tools this member may use at this level: insight tools and prepare-only actions. */
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
      clientApp: sessionClientApp(context),
      config: context.config,
    });
    const now = new Date();
    const features = await withTenant(context.principal.tenantId, (tx) =>
      tx.featureFlags.resolved(),
    );
    return {
      status: 200,
      body: {
        level: access.level,
        blockedBy: access.blockedBy,
        channel: access.channel,
        answerSource: access.policy.answersFrom,
        tools: offeredToolKeys({
          access,
          principal: context.principal,
          features,
          config: context.config,
          tools: context.services.ai.tools,
        }),
        companyDataToProvider: access.policy.companyDataToProvider,
        locales: ['en', 'ar'],
        historyTurns: context.config.AI_HISTORY_TURNS,
        allowHistory: access.policy.allowHistory,
        usage: await usageOf(context.principal, access, now),
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
    'What is left of the member’s own share of the company’s allowance, as a percentage, with the UTC instant it resets; and, for those who assign shares, the company’s. Requests still being answered count against what is left. No count, token figure or price is ever returned (ADR-0002).',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The usage.', schema: aiUsageSchema } },
  handler: async (_input, context) => {
    const access = await resolveAiAccess({
      principal: context.principal,
      clientApp: sessionClientApp(context),
      config: context.config,
    });
    return { status: 200, body: await usageOf(context.principal, access, new Date()) };
  },
});

// ---------------------------------------------------------------------------
// Conversations (docs/ai §5.1)
// ---------------------------------------------------------------------------

const localeSchema = z.enum(['en', 'ar']);

const conversationSchema = z.object({
  id: z.uuid(),
  title: z.string().nullable(),
  locale: localeSchema,
  level: z.enum(AI_LEVELS),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const proposalSchema = z.object({
  id: z.uuid(),
  toolKey: z.string(),
  state: z.enum(AI_PROPOSAL_STATES),
  /** What will happen, field by field, in the member's language. */
  preview: z.object({
    title: z.string(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })),
    warnings: z.array(z.string()),
  }),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  /** The record made or changed, once completed. */
  result: z
    .object({
      resourceType: z.string(),
      resourceId: z.string(),
      summary: z.string(),
      appRoute: z.string(),
    })
    .nullable(),
  errorCode: z.string().nullable(),
});

const messageSchema = z.object({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'tool_summary']),
  text: z.string(),
  sources: z.array(aiSourceRefSchema),
  toolSummaries: z.array(aiToolSummarySchema),
  /** A prepared action waiting for the member's confirmation, or its outcome. */
  actionProposal: proposalSchema.nullable(),
  createdAt: z.iso.datetime(),
});

const answerSchema = z.object({
  message: messageSchema,
  /** What is left of the member's own share after this answer. */
  allowance: aiAllowanceSchema,
  /** True when this answer was stored by an earlier request with the same Idempotency-Key. */
  replayed: z.boolean(),
});

export const createConversationRoute = defineRoute({
  method: 'post',
  path: '/v1/ai/conversations',
  operationId: 'createAiConversation',
  summary: 'Start a private conversation with the assistant',
  description:
    'Private to the member who starts it: nobody else in the company, owners included, can read it. Refused with 403 `ai_disabled` when the assistant is off for this company, this app or this member.',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: z.object({ locale: localeSchema.default('en') }),
  responses: {
    201: { description: 'Started.', schema: conversationSchema },
    403: { description: 'The assistant is not available (`ai_disabled`).' },
  },
  handler: async ({ body }, context) => {
    const access = await resolveAiAccess({
      principal: context.principal,
      clientApp: sessionClientApp(context),
      config: context.config,
    });
    assertAiLevel(access, 'help');
    const created = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiConversations.create({
        userId: context.principal.userId,
        locale: body.locale,
        level: access.level,
      }),
    );
    return {
      status: 201,
      body: {
        id: created.id,
        title: created.title,
        locale: created.locale as 'en' | 'ar',
        level: created.levelAtCreation,
        createdAt: iso(created.createdAt),
        updatedAt: iso(created.updatedAt),
      },
    };
  },
});

export const listConversationsRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/conversations',
  operationId: 'listAiConversations',
  summary: 'The signed-in member’s conversations, newest first',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The conversations.',
      schema: z.object({ items: z.array(conversationSchema) }),
    },
    403: { description: 'The assistant is not available (`ai_disabled`).' },
  },
  handler: async (_input, context) => {
    const access = await resolveAiAccess({
      principal: context.principal,
      clientApp: sessionClientApp(context),
      config: context.config,
    });
    assertAiLevel(access, 'help');
    const items = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiConversations.listForUser(context.principal.userId),
    );
    return {
      status: 200,
      body: {
        items: items.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          locale: conversation.locale as 'en' | 'ar',
          level: conversation.levelAtCreation,
          createdAt: iso(conversation.createdAt),
          updatedAt: iso(conversation.updatedAt),
        })),
      },
    };
  },
});

export const getConversationRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/conversations/:conversationId',
  operationId: 'getAiConversation',
  summary: 'One conversation with its messages',
  description:
    'Only the member who started it can read it; anybody else is told it does not exist.',
  tags: TAGS,
  security: 'authenticated',
  params: z.object({ conversationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The conversation.',
      schema: z.object({ conversation: conversationSchema, messages: z.array(messageSchema) }),
    },
    404: { description: 'No such conversation (`ai_conversation_not_found`).' },
  },
  handler: async ({ params }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const conversation = await tx.aiConversations.findForUser(
        params.conversationId,
        context.principal.userId,
      );
      if (conversation === undefined) {
        return undefined;
      }
      return { conversation, messages: await tx.aiConversations.listMessages(conversation.id) };
    });
    if (result === undefined) {
      throw aiConversationNotFound();
    }
    return {
      status: 200,
      body: {
        conversation: {
          id: result.conversation.id,
          title: result.conversation.title,
          locale: result.conversation.locale as 'en' | 'ar',
          level: result.conversation.levelAtCreation,
          createdAt: iso(result.conversation.createdAt),
          updatedAt: iso(result.conversation.updatedAt),
        },
        messages: await Promise.all(
          result.messages.map(async (message) => ({
            ...(await withProposal(
              context.principal.tenantId,
              context.principal.userId,
              toOutputMessage(message),
              message.actionProposalId,
            )),
            role: message.role,
          })),
        ),
      },
    };
  },
});

export const deleteConversationRoute = defineRoute({
  method: 'delete',
  path: '/v1/ai/conversations/:conversationId',
  operationId: 'deleteAiConversation',
  summary: 'Delete one of your conversations',
  description:
    'The chat goes; the record that messages were charged stays, because that is the company’s usage and not the conversation.',
  tags: TAGS,
  security: 'authenticated',
  allowedWhenReadOnly: true,
  params: z.object({ conversationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Deleted.' },
    404: { description: 'No such conversation (`ai_conversation_not_found`).' },
  },
  handler: async ({ params }, context) => {
    const deleted = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiConversations.softDeleteForUser(params.conversationId, context.principal.userId),
    );
    if (!deleted) {
      throw aiConversationNotFound();
    }
    return { status: 204, body: undefined };
  },
});

export const postMessageRoute = defineRoute({
  method: 'post',
  path: '/v1/ai/conversations/:conversationId/messages',
  operationId: 'postAiMessage',
  summary: 'Ask the assistant a question',
  description:
    'Needs an `Idempotency-Key`: the same key with the same question is answered once and replayed, never charged twice. One durably stored answer is one message against the company’s and the member’s allowance. Refused while the company is read-only for non-payment, like every other write.',
  tags: TAGS,
  security: 'authenticated',
  idempotent: 'required',
  params: z.object({ conversationId: z.uuid() }),
  query: noSchema,
  body: z.object({
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    locale: localeSchema.default('en'),
    /** A hint about where the member is, never proof they may see anything. */
    clientContext: z
      .object({ page: z.string().max(64).optional(), entityId: z.uuid().nullable().optional() })
      .optional(),
  }),
  responses: {
    200: { description: 'The answer, and what is left.', schema: answerSchema },
    403: { description: 'The assistant is not available (`ai_disabled`).' },
    404: { description: 'No such conversation (`ai_conversation_not_found`).' },
    409: { description: 'The same question is still being answered (`ai_request_in_progress`).' },
    429: {
      description:
        'The day’s or month’s messages are used up (`ai_daily_quota_exceeded`, `ai_monthly_quota_exceeded`), or too many at once (`ai_concurrency_limit`).',
    },
    503: {
      description:
        'The model could not be reached (`ai_provider_unavailable`), or the assistant is paused (`ai_budget_unavailable`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const answer = await answerMessage({
      principal: context.principal,
      clientApp: sessionClientApp(context),
      conversationId: params.conversationId,
      message: body.message,
      locale: body.locale,
      clientRequestId: context.idempotencyKey ?? '',
      requestId: context.requestId,
      config: context.config,
      services: context.services.ai,
      logger: context.logger,
    });
    return { status: 200, body: answer };
  },
});

// ---------------------------------------------------------------------------
// Actions (docs/ai §9)
// ---------------------------------------------------------------------------

export const getActionRoute = defineRoute({
  method: 'get',
  path: '/v1/ai/actions/:proposalId',
  operationId: 'getAiAction',
  summary: 'One of your prepared actions, and where it stands',
  tags: TAGS,
  security: 'authenticated',
  params: z.object({ proposalId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The proposal.', schema: proposalSchema },
    404: { description: 'No such proposal (`ai_action_not_found`).' },
  },
  handler: async ({ params }, context) => ({
    status: 200,
    body: await getProposal(context, params.proposalId),
  }),
});

export const confirmActionRoute = defineRoute({
  method: 'post',
  path: '/v1/ai/actions/:proposalId/confirm',
  operationId: 'confirmAiAction',
  summary: 'Carry out an action the assistant prepared',
  description:
    'Only the member who asked, only while the proposal is pending and in time, and only after the company’s level, the seat’s permission, the module and the records concerned have been checked again. Runs through the same code as the screen would, in the member’s name, exactly once: a second confirmation answers 409 `ai_action_already_executed`. Needs an `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  idempotent: 'required',
  params: z.object({ proposalId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Done; the proposal with its result.', schema: proposalSchema },
    403: { description: 'Not allowed any more (`ai_disabled`, `ai_tool_forbidden`).' },
    404: { description: 'No such proposal (`ai_action_not_found`).' },
    409: {
      description:
        'Expired or changed (`ai_action_expired`), or already carried out (`ai_action_already_executed`).',
    },
  },
  handler: async ({ params }, context) => ({
    status: 200,
    body: await confirmProposal(context, ACTION_CATALOGUE, params.proposalId),
  }),
});

export const rejectActionRoute = defineRoute({
  method: 'post',
  path: '/v1/ai/actions/:proposalId/reject',
  operationId: 'rejectAiAction',
  summary: 'Decline an action the assistant prepared',
  tags: TAGS,
  security: 'authenticated',
  allowedWhenReadOnly: true,
  params: z.object({ proposalId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Declined.', schema: proposalSchema },
    404: { description: 'No such proposal (`ai_action_not_found`).' },
    409: { description: 'Already carried out (`ai_action_already_executed`).' },
  },
  handler: async ({ params }, context) => ({
    status: 200,
    body: await rejectProposal(context, params.proposalId),
  }),
});

export const aiRoutes = [
  getActionRoute,
  confirmActionRoute,
  rejectActionRoute,
  aiCapabilitiesRoute,
  aiUsageRoute,
  createConversationRoute,
  listConversationsRoute,
  getConversationRoute,
  deleteConversationRoute,
  postMessageRoute,
];
