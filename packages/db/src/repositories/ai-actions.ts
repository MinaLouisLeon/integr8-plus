import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { AiActionProposalsTable, AiProposalState } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Actions the assistant prepared and a member may confirm (docs/ai; ADR-0001).
 *
 * A proposal is frozen when it is written: the payload, its digest and the
 * versions of the records it touches. Changing one is a new proposal. The
 * state moves by compare-and-swap, so a double click or a retried confirmation
 * finds the first one's result rather than running the action again.
 */

export interface AiActionProposal {
  id: string;
  userId: UserId;
  conversationId: string;
  toolKey: string;
  typedPayload: Record<string, unknown>;
  payloadSchemaVersion: number;
  displaySummary: Record<string, unknown>;
  requestDigest: string;
  resourceVersions: Record<string, unknown>;
  state: AiProposalState;
  expiresAt: Date;
  confirmedAt: Date | null;
  resultResourceType: string | null;
  resultResourceId: string | null;
  resultSummary: Record<string, unknown> | null;
  executionIdempotencyKey: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateAiActionProposalInput {
  userId: UserId | string;
  conversationId: string;
  toolKey: string;
  typedPayload: Record<string, unknown>;
  payloadSchemaVersion?: number;
  displaySummary: Record<string, unknown>;
  requestDigest: string;
  resourceVersions?: Record<string, unknown>;
  expiresAt: Date;
}

export interface AiActionEvent {
  id: string;
  proposalId: string;
  actorUserId: UserId | null;
  action: string;
  code: string | null;
  requestId: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

export class AiActionsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(input: CreateAiActionProposalInput): Promise<AiActionProposal> {
    const row = await this.db
      .insertInto('ai_action_proposals')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        conversation_id: input.conversationId,
        tool_key: input.toolKey,
        typed_payload: input.typedPayload,
        payload_schema_version: input.payloadSchemaVersion ?? 1,
        display_summary: input.displaySummary,
        request_digest: input.requestDigest,
        resource_versions: input.resourceVersions ?? {},
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProposal(row);
  }

  /** The member's own proposal; anybody else's is not found. */
  async findForUser(
    proposalId: string,
    userId: UserId | string,
  ): Promise<AiActionProposal | undefined> {
    const row = await this.db
      .selectFrom('ai_action_proposals')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', proposalId)
      .where('user_id', '=', toUserId(userId))
      .executeTakeFirst();
    return row === undefined ? undefined : toProposal(row);
  }

  /**
   * Moves a proposal from one state to the next, only if it is still in the
   * state the caller saw. Returns the row after, or undefined when somebody
   * else moved it first.
   */
  async transition(input: {
    proposalId: string;
    from: AiProposalState | readonly AiProposalState[];
    to: AiProposalState;
    confirmedAt?: Date | null;
    executionIdempotencyKey?: string | null;
    resultResourceType?: string | null;
    resultResourceId?: string | null;
    resultSummary?: Record<string, unknown> | null;
    errorCode?: string | null;
  }): Promise<AiActionProposal | undefined> {
    const from = typeof input.from === 'string' ? [input.from] : [...input.from];
    const row = await this.db
      .updateTable('ai_action_proposals')
      .set({
        state: input.to,
        updated_at: sql`now()`,
        ...(input.confirmedAt === undefined ? {} : { confirmed_at: input.confirmedAt }),
        ...(input.executionIdempotencyKey === undefined
          ? {}
          : { execution_idempotency_key: input.executionIdempotencyKey }),
        ...(input.resultResourceType === undefined
          ? {}
          : { result_resource_type: input.resultResourceType }),
        ...(input.resultResourceId === undefined
          ? {}
          : { result_resource_id: input.resultResourceId }),
        ...(input.resultSummary === undefined ? {} : { result_summary: input.resultSummary }),
        ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', input.proposalId)
      .where('state', 'in', from)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? undefined : toProposal(row);
  }

  /** Marks every pending proposal past its time as expired. Returns how many. */
  async expirePending(now: Date): Promise<number> {
    const result = await this.db
      .updateTable('ai_action_proposals')
      .set({ state: 'expired', updated_at: sql`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('state', '=', 'pending')
      .where('expires_at', '<=', now)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async appendEvent(input: {
    proposalId: string;
    actorUserId: UserId | string | null;
    action: string;
    code?: string | null;
    requestId?: string | null;
    details?: Record<string, unknown>;
  }): Promise<AiActionEvent> {
    const row = await this.db
      .insertInto('ai_action_events')
      .values({
        tenant_id: this.tenantId,
        proposal_id: input.proposalId,
        actor_user_id: input.actorUserId === null ? null : toUserId(input.actorUserId),
        action: input.action,
        code: input.code ?? null,
        request_id: input.requestId ?? null,
        details: input.details ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return {
      id: row.id,
      proposalId: row.proposal_id,
      actorUserId: row.actor_user_id === null ? null : toUserId(row.actor_user_id),
      action: row.action,
      code: row.code,
      requestId: row.request_id,
      details: row.details,
      createdAt: row.created_at,
    };
  }

  async events(proposalId: string): Promise<AiActionEvent[]> {
    const rows = await this.db
      .selectFrom('ai_action_events')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('proposal_id', '=', proposalId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      proposalId: row.proposal_id,
      actorUserId: row.actor_user_id === null ? null : toUserId(row.actor_user_id),
      action: row.action,
      code: row.code,
      requestId: row.request_id,
      details: row.details,
      createdAt: row.created_at,
    }));
  }
}

function toProposal(row: Selectable<AiActionProposalsTable>): AiActionProposal {
  return {
    id: row.id,
    userId: toUserId(row.user_id),
    conversationId: row.conversation_id,
    toolKey: row.tool_key,
    typedPayload: row.typed_payload,
    payloadSchemaVersion: row.payload_schema_version,
    displaySummary: row.display_summary,
    requestDigest: row.request_digest,
    resourceVersions: row.resource_versions,
    state: row.state,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    resultResourceType: row.result_resource_type,
    resultResourceId: row.result_resource_id,
    resultSummary: row.result_summary,
    executionIdempotencyKey: row.execution_idempotency_key,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
