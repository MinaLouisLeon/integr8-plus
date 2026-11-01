import { type AiToolSummary, hasFeature, holds, type Principal } from '@integr8/core';
import { type AiActionProposal, withTenant } from '@integr8/db';
import { z } from 'zod';
import type { ApiConfig } from '../../config.js';
import { ApiError } from '../../http/errors.js';
import type { RequestContext } from '../../http/routes.js';
import {
  aiActionAlreadyExecuted,
  aiActionExpired,
  aiDisabled,
  aiToolForbidden,
} from '../errors.js';
import { resolveAiAccess, sessionClientApp } from '../policy.js';
import { approvedDataClasses } from '../providers/index.js';
import { type AnyAiTool, defineTool, type ToolGateInput } from '../tools/registry.js';
import { type ActionPreview, type AnyAiAction, payloadDigest } from './registry.js';

/**
 * From the model's request to a frozen proposal, and from the member's
 * confirmation to the record (docs/ai §9.2–9.3; ADR-0001 D4).
 *
 * The model sees each action only as a `prepare_*` tool: calling it writes a
 * proposal and answers with the preview and the proposal's id. Nothing moves
 * until `confirmProposal`, which only the confirm route calls, with the
 * member's own token, after every gate is checked again.
 */

/** What a client is shown for a proposal, in the chat and on the confirm card. */
export interface ProposalView {
  id: string;
  toolKey: string;
  state: AiActionProposal['state'];
  preview: ActionPreview;
  expiresAt: string;
  createdAt: string;
  result: { resourceType: string; resourceId: string; summary: string; appRoute: string } | null;
  errorCode: string | null;
}

const previewSchema = z.object({
  title: z.string(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
  warnings: z.array(z.string()),
});

export function proposalView(proposal: AiActionProposal): ProposalView {
  const preview = previewSchema.safeParse(proposal.displaySummary);
  const result = proposal.resultSummary as {
    resourceType?: string;
    resourceId?: string;
    summary?: string;
    appRoute?: string;
  } | null;
  return {
    id: proposal.id,
    toolKey: proposal.toolKey,
    state: proposal.state,
    preview: preview.success ? preview.data : { title: proposal.toolKey, fields: [], warnings: [] },
    expiresAt: proposal.expiresAt.toISOString(),
    createdAt: proposal.createdAt.toISOString(),
    result:
      proposal.resultResourceId === null || proposal.resultResourceType === null
        ? null
        : {
            resourceType: proposal.resultResourceType,
            resourceId: proposal.resultResourceId,
            summary: result?.summary ?? '',
            appRoute: result?.appRoute ?? '',
          },
    errorCode: proposal.errorCode,
  };
}

/**
 * Each action as a tool the model may call at the agent level. The tool's
 * output is the proposal view, which the chat stores on the assistant message
 * and the client renders as a confirmation card.
 */
export function prepareTools(
  catalogue: readonly AnyAiAction[],
  options: { conversationId: string; config: ApiConfig; onProposal: (view: ProposalView) => void },
): AnyAiTool[] {
  return catalogue.map((action) =>
    defineTool({
      key: action.key,
      description: `${action.description} Returns a proposal the person must confirm; never say it was done.`,
      minLevel: 'agent',
      permission: action.permission,
      ...(action.feature === undefined ? {} : { feature: action.feature }),
      dataClass: action.dataClass,
      inputSchema: action.inputSchema,
      maxRows: 1,
      async execute(context, input) {
        const prepared = await action.prepare(context, input);
        const proposal = await context.tx.aiActions.create({
          userId: context.principal.userId,
          conversationId: options.conversationId,
          toolKey: action.key,
          typedPayload: prepared.payload as Record<string, unknown>,
          payloadSchemaVersion: action.payloadSchemaVersion,
          displaySummary: prepared.preview as unknown as Record<string, unknown>,
          requestDigest: payloadDigest(action.key, prepared.payload),
          resourceVersions: prepared.resourceVersions,
          expiresAt: new Date(context.now.getTime() + options.config.AI_ACTION_TTL_SECONDS * 1000),
        });
        await context.tx.aiActions.appendEvent({
          proposalId: proposal.id,
          actorUserId: context.principal.userId,
          action: 'proposed',
          details: { toolKey: action.key },
        });
        const view = proposalView(proposal);
        options.onProposal(view);
        return {
          proposalId: proposal.id,
          preview: prepared.preview,
          note: 'The person must confirm this proposal on screen before anything is saved.',
        };
      },
      summarise(output: { preview: ActionPreview }) {
        return output.preview.title;
      },
    }),
  );
}

/** The summary the stored message carries for a proposal the model prepared. */
export function proposalSummary(view: ProposalView): AiToolSummary {
  return { tool: view.toolKey, result: view.preview.title };
}

// ---------------------------------------------------------------------------
// Confirming and rejecting
// ---------------------------------------------------------------------------

async function ownProposal(context: RequestContext, proposalId: string): Promise<AiActionProposal> {
  const proposal = await withTenant(context.principal.tenantId, (tx) =>
    tx.aiActions.findForUser(proposalId, context.principal.userId),
  );
  if (proposal === undefined) {
    throw new ApiError(404, 'ai_action_not_found', 'No such proposal.');
  }
  return proposal;
}

export async function getProposal(
  context: RequestContext,
  proposalId: string,
): Promise<ProposalView> {
  return proposalView(await ownProposal(context, proposalId));
}

/**
 * Carries out a proposal, once.
 *
 * The order is the security order: the proposal is the member's own and still
 * pending and in time; the company is still on the agent level and the seat
 * still holds the permission and the module; the records the payload names
 * are as they were; then, and only then, the state moves to executing by
 * compare-and-swap and the domain code runs in the member's name. A second
 * confirmation finds the state moved and is answered with the stored result.
 */
export async function confirmProposal(
  context: RequestContext,
  catalogue: readonly AnyAiAction[],
  proposalId: string,
  now = new Date(),
): Promise<ProposalView> {
  const proposal = await ownProposal(context, proposalId);
  if (proposal.state === 'completed') {
    throw aiActionAlreadyExecuted();
  }
  if (proposal.state !== 'pending') {
    throw aiActionExpired();
  }
  if (proposal.expiresAt.getTime() <= now.getTime()) {
    await withTenant(context.principal.tenantId, (tx) =>
      tx.aiActions.transition({ proposalId, from: 'pending', to: 'expired' }),
    );
    throw aiActionExpired();
  }

  const action = catalogue.find((candidate) => candidate.key === proposal.toolKey);
  if (action === undefined) {
    throw aiToolForbidden(proposal.toolKey);
  }
  const payload = action.payloadSchema.safeParse(proposal.typedPayload);
  if (!payload.success || payloadDigest(action.key, payload.data) !== proposal.requestDigest) {
    throw aiActionExpired();
  }

  // Every gate again, with what is true now.
  const access = await resolveAiAccess({
    principal: context.principal,
    clientApp: sessionClientApp(context),
    config: context.config,
  });
  if (access.level !== 'agent') {
    throw aiDisabled(access.blockedBy ?? 'level agent not included');
  }
  const gate = await gateNow(context, action, access.policy.companyDataToProvider);
  if (gate !== null) {
    await deny(context, proposalId, gate);
    throw aiToolForbidden(action.key);
  }

  const claimed = await withTenant(context.principal.tenantId, (tx) =>
    tx.aiActions.transition({
      proposalId,
      from: 'pending',
      to: 'executing',
      confirmedAt: now,
      executionIdempotencyKey: context.idempotencyKey ?? null,
    }),
  );
  if (claimed === undefined) {
    // Somebody else's confirmation got there first, or the reconciler expired it.
    const current = await ownProposal(context, proposalId);
    if (current.state === 'completed') {
      throw aiActionAlreadyExecuted();
    }
    throw aiActionExpired();
  }

  try {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const features = await tx.featureFlags.resolved();
      const stillValid = await action.verify(
        {
          principal: context.principal,
          tx,
          features,
          locale: 'en',
          now,
        },
        payload.data,
        proposal.resourceVersions,
      );
      if (!stillValid) {
        throw aiActionExpired();
      }
      const outcome = await action.execute({ context, tx, features, proposalId }, payload.data);
      await tx.aiActions.appendEvent({
        proposalId,
        actorUserId: context.principal.userId,
        action: 'confirmed',
        requestId: context.requestId,
        details: { resourceType: outcome.resourceType, resourceId: outcome.resourceId },
      });
      return outcome;
    });
    const completed = await withTenant(context.principal.tenantId, (tx) =>
      tx.aiActions.transition({
        proposalId,
        from: 'executing',
        to: 'completed',
        resultResourceType: result.resourceType,
        resultResourceId: result.resourceId,
        resultSummary: { summary: result.summary, appRoute: result.appRoute },
      }),
    );
    context.logger.info('ai.action.completed', {
      tenantId: context.principal.tenantId,
      proposalId,
      toolKey: action.key,
      resourceType: result.resourceType,
    });
    return proposalView(completed ?? (await ownProposal(context, proposalId)));
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'failed';
    const to =
      error instanceof ApiError && error.code === 'ai_action_expired' ? 'expired' : 'failed';
    await withTenant(context.principal.tenantId, async (tx) => {
      await tx.aiActions.transition({ proposalId, from: 'executing', to, errorCode: code });
      await tx.aiActions.appendEvent({
        proposalId,
        actorUserId: context.principal.userId,
        action: to,
        code,
        requestId: context.requestId,
      });
    });
    context.logger.warn('ai.action.denied', {
      tenantId: context.principal.tenantId,
      proposalId,
      toolKey: action.key,
      code,
    });
    throw error;
  }
}

export async function rejectProposal(
  context: RequestContext,
  proposalId: string,
): Promise<ProposalView> {
  const proposal = await ownProposal(context, proposalId);
  if (proposal.state === 'completed') {
    throw aiActionAlreadyExecuted();
  }
  const rejected = await withTenant(context.principal.tenantId, async (tx) => {
    const moved = await tx.aiActions.transition({ proposalId, from: 'pending', to: 'rejected' });
    if (moved !== undefined) {
      await tx.aiActions.appendEvent({
        proposalId,
        actorUserId: context.principal.userId,
        action: 'rejected',
        requestId: context.requestId,
      });
    }
    return moved;
  });
  return proposalView(rejected ?? proposal);
}

async function gateNow(
  context: RequestContext,
  action: AnyAiAction,
  companyDataToProvider: boolean,
): Promise<ToolGateInput['level'] | 'permission' | 'feature' | 'data_class' | null> {
  const permissions =
    typeof action.permission === 'string' ? [action.permission] : action.permission;
  if (
    !permissions.some((permission: Parameters<typeof holds>[1]) =>
      holds(context.principal, permission),
    )
  ) {
    return 'permission';
  }
  if (action.feature !== undefined) {
    const features = await withTenant(context.principal.tenantId, (tx) =>
      tx.featureFlags.resolved(),
    );
    if (!hasFeature(features, action.feature)) {
      return 'feature';
    }
  }
  if (
    action.dataClass !== 'public_help' &&
    (!companyDataToProvider ||
      !approvedDataClasses(context.config.AI_PROVIDER, context.config).includes(action.dataClass))
  ) {
    return 'data_class';
  }
  return null;
}

async function deny(context: RequestContext, proposalId: string, gate: string): Promise<void> {
  await withTenant(context.principal.tenantId, async (tx) => {
    await tx.aiActions.transition({ proposalId, from: 'pending', to: 'rejected', errorCode: gate });
    await tx.aiActions.appendEvent({
      proposalId,
      actorUserId: context.principal.userId,
      action: 'denied',
      code: gate,
      requestId: context.requestId,
    });
  });
}

export type { Principal };
