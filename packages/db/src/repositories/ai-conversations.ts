import { type TenantId, toTenantId, type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { AiConversationsTable, AiLevel, AiMessageRole, AiMessagesTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * A member's conversations with the assistant (docs/ai; ADR-0001).
 *
 * Private to the member who started each one: every read here takes the
 * member as well as the company, so an owner reading a colleague's chat is not
 * a permission this repository can be asked for. Deleting is soft and the
 * retention sweep is what actually removes rows, so a deleted chat still
 * answers a replayed request for the minute that matters.
 */

export interface AiConversation {
  id: string;
  tenantId: TenantId;
  createdByUserId: UserId;
  title: string | null;
  locale: string;
  levelAtCreation: AiLevel;
  createdAt: Date;
  updatedAt: Date;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  userId: UserId | null;
  role: AiMessageRole;
  content: string;
  sourceRefs: unknown[];
  toolSummaries: unknown[];
  actionProposalId: string | null;
  usageReservationId: string | null;
  redacted: boolean;
  createdAt: Date;
}

export interface AppendAiMessageInput {
  conversationId: string;
  userId: UserId | string | null;
  role: AiMessageRole;
  content: string;
  sourceRefs?: unknown[];
  toolSummaries?: unknown[];
  actionProposalId?: string | null;
  usageReservationId?: string | null;
}

export class AiConversationsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async create(input: {
    userId: UserId | string;
    locale: string;
    level: AiLevel;
    title?: string | null;
  }): Promise<AiConversation> {
    const row = await this.db
      .insertInto('ai_conversations')
      .values({
        tenant_id: this.tenantId,
        created_by_user_id: toUserId(input.userId),
        locale: input.locale,
        level_at_creation: input.level,
        title: input.title ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConversation(row);
  }

  async findForUser(
    conversationId: string,
    userId: UserId | string,
  ): Promise<AiConversation | undefined> {
    const row = await this.db
      .selectFrom('ai_conversations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', conversationId)
      .where('created_by_user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? undefined : toConversation(row);
  }

  async listForUser(userId: UserId | string, limit = 50): Promise<AiConversation[]> {
    const rows = await this.db
      .selectFrom('ai_conversations')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('created_by_user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toConversation);
  }

  /** Names a conversation after its first question, once. */
  async setTitle(conversationId: string, title: string): Promise<void> {
    await this.db
      .updateTable('ai_conversations')
      .set({ title: title.slice(0, 200), updated_at: sql`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', conversationId)
      .where('title', 'is', null)
      .execute();
  }

  async touch(conversationId: string): Promise<void> {
    await this.db
      .updateTable('ai_conversations')
      .set({ updated_at: sql`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', conversationId)
      .execute();
  }

  /** The member's own: anybody else's is not found. */
  async softDeleteForUser(conversationId: string, userId: UserId | string): Promise<boolean> {
    const result = await this.db
      .updateTable('ai_conversations')
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', conversationId)
      .where('created_by_user_id', '=', toUserId(userId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  async appendMessage(input: AppendAiMessageInput): Promise<AiMessage> {
    const row = await this.db
      .insertInto('ai_messages')
      .values({
        tenant_id: this.tenantId,
        conversation_id: input.conversationId,
        user_id: input.userId === null ? null : toUserId(input.userId),
        role: input.role,
        content: input.content,
        source_refs: JSON.stringify(input.sourceRefs ?? []),
        tool_summaries: JSON.stringify(input.toolSummaries ?? []),
        action_proposal_id: input.actionProposalId ?? null,
        usage_reservation_id: input.usageReservationId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMessage(row);
  }

  async findMessage(messageId: string): Promise<AiMessage | undefined> {
    const row = await this.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', messageId)
      .executeTakeFirst();
    return row === undefined ? undefined : toMessage(row);
  }

  /**
   * The assistant's answer stored against a reservation, if one was. The
   * reconciler asks this of a slot the worker never settled: an answer that
   * reached the table is the charging boundary, whatever happened after.
   */
  async findAnswerForReservation(reservationId: string): Promise<AiMessage | undefined> {
    const row = await this.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('usage_reservation_id', '=', reservationId)
      .where('role', '=', 'assistant')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    return row === undefined ? undefined : toMessage(row);
  }

  /** Oldest first, bounded; `before` pages backwards from a message id's time. */
  async listMessages(
    conversationId: string,
    options: { limit?: number } = {},
  ): Promise<AiMessage[]> {
    const rows = await this.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(options.limit ?? 200)
      .execute();
    return rows.map(toMessage);
  }

  /** The last few turns, newest last, for the prompt's bounded context. */
  async recentMessages(conversationId: string, limit: number): Promise<AiMessage[]> {
    const rows = await this.db
      .selectFrom('ai_messages')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('conversation_id', '=', conversationId)
      .where('role', 'in', ['user', 'assistant'])
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.reverse().map(toMessage);
  }

  /**
   * Removes conversations older than the retention window, or deleted by their
   * member, together with their messages. Reservations and provider calls stay:
   * they are the charge record, not the chat.
   */
  async sweep(olderThan: Date, limit = 200): Promise<number> {
    const victims = await this.db
      .selectFrom('ai_conversations')
      .select('id')
      .where('tenant_id', '=', this.tenantId)
      .where((eb) => eb.or([eb('updated_at', '<', olderThan), eb('deleted_at', 'is not', null)]))
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .execute();
    if (victims.length === 0) {
      return 0;
    }
    const ids = victims.map((row) => row.id);
    await this.db
      .deleteFrom('ai_messages')
      .where('tenant_id', '=', this.tenantId)
      .where('conversation_id', 'in', ids)
      .execute();
    await this.db
      .deleteFrom('ai_conversations')
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', ids)
      .execute();
    return ids.length;
  }
}

function toConversation(row: Selectable<AiConversationsTable>): AiConversation {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    createdByUserId: toUserId(row.created_by_user_id),
    title: row.title,
    locale: row.locale,
    levelAtCreation: row.level_at_creation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: Selectable<AiMessagesTable>): AiMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id === null ? null : toUserId(row.user_id),
    role: row.role,
    content: row.content,
    sourceRefs: Array.isArray(row.source_refs) ? row.source_refs : [],
    toolSummaries: Array.isArray(row.tool_summaries) ? row.tool_summaries : [],
    actionProposalId: row.action_proposal_id,
    usageReservationId: row.usage_reservation_id,
    redacted: row.redacted,
    createdAt: row.created_at,
  };
}
