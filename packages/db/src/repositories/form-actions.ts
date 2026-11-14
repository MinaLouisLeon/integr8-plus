import { toUserId, type UserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type {
  SubmissionActionOutcome,
  SubmissionActionResultsTable,
  SubmissionLinksTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * What a submitted form's actions did (0079, P40): the follow-up submissions
 * they opened, and the last outcome of each action. Links never change; an
 * outcome changes only until it is made, which the database's guards enforce.
 */

export interface SubmissionLink {
  id: string;
  fromSubmissionId: string;
  toSubmissionId: string;
  formActionId: string;
  required: boolean;
  createdAt: Date;
}

export interface SubmissionActionResult {
  submissionId: string;
  formActionId: string;
  kind: 'expense_claim' | 'open_form';
  outcome: SubmissionActionOutcome;
  claimId: string | null;
  linkId: string | null;
  reasonCode: string | null;
  reason: string | null;
  attempts: number;
  attemptedBy: UserId;
  attemptedAt: Date;
}

export interface SubmissionActionResultInput {
  submissionId: string;
  formActionId: string;
  kind: 'expense_claim' | 'open_form';
  outcome: SubmissionActionOutcome;
  claimId?: string | null;
  linkId?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
}

function toLink(row: Selectable<SubmissionLinksTable>): SubmissionLink {
  return {
    id: row.id,
    fromSubmissionId: row.from_submission_id,
    toSubmissionId: row.to_submission_id,
    formActionId: row.form_action_id,
    required: row.required,
    createdAt: row.created_at,
  };
}

function toResult(row: Selectable<SubmissionActionResultsTable>): SubmissionActionResult {
  return {
    submissionId: row.submission_id,
    formActionId: row.form_action_id,
    kind: row.kind,
    outcome: row.outcome,
    claimId: row.claim_id,
    linkId: row.link_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    attempts: row.attempts,
    attemptedBy: toUserId(row.attempted_by),
    attemptedAt: row.attempted_at,
  };
}

export class FormActionsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async link(fromSubmissionId: string, formActionId: string): Promise<SubmissionLink | undefined> {
    const row = await this.db
      .selectFrom('submission_links')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('from_submission_id', '=', fromSubmissionId)
      .where('form_action_id', '=', formActionId)
      .executeTakeFirst();
    return row === undefined ? undefined : toLink(row);
  }

  async createLink(input: {
    fromSubmissionId: string;
    toSubmissionId: string;
    formActionId: string;
    required: boolean;
  }): Promise<SubmissionLink> {
    const row = await this.db
      .insertInto('submission_links')
      .values({
        tenant_id: this.tenantId,
        from_submission_id: input.fromSubmissionId,
        to_submission_id: input.toSubmissionId,
        form_action_id: input.formActionId,
        required: input.required,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toLink(row);
  }

  /** The follow-ups this submission opened, and the one that opened it. */
  async linksOf(
    submissionId: string,
  ): Promise<{ to: SubmissionLink[]; from: SubmissionLink | null }> {
    const rows = await this.db
      .selectFrom('submission_links')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where((eb) =>
        eb.or([
          eb('from_submission_id', '=', submissionId),
          eb('to_submission_id', '=', submissionId),
        ]),
      )
      .orderBy('created_at')
      .execute();
    const links = rows.map(toLink);
    return {
      to: links.filter((link) => link.fromSubmissionId === submissionId),
      from: links.find((link) => link.toSubmissionId === submissionId) ?? null,
    };
  }

  async results(submissionId: string): Promise<SubmissionActionResult[]> {
    const rows = await this.db
      .selectFrom('submission_action_results')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('submission_id', '=', submissionId)
      .orderBy('attempted_at')
      .execute();
    return rows.map(toResult);
  }

  /**
   * Records an action's outcome. A second attempt replaces a skipped or failed
   * one and counts it; a made one is never replaced (the guard refuses, and
   * callers check first).
   */
  async recordResult(
    input: SubmissionActionResultInput,
    by: UserId | string,
  ): Promise<SubmissionActionResult> {
    const values = {
      kind: input.kind,
      outcome: input.outcome,
      claim_id: input.claimId ?? null,
      link_id: input.linkId ?? null,
      reason_code: input.reasonCode ?? null,
      reason: input.reason ?? null,
      attempted_by: toUserId(by),
    };
    const row = await this.db
      .insertInto('submission_action_results')
      .values({
        tenant_id: this.tenantId,
        submission_id: input.submissionId,
        form_action_id: input.formActionId,
        ...values,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'submission_id', 'form_action_id']).doUpdateSet({
          ...values,
          attempts: sql<number>`submission_action_results.attempts + 1`,
          attempted_at: sql<Date>`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toResult(row);
  }

  /**
   * Runs one action inside a savepoint, so a database refusal undoes that
   * action alone and leaves the submit it follows standing. Kysely has no
   * nested transaction on an open one, so it is said in SQL.
   */
  async attempt<T>(
    work: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    await sql`savepoint form_action`.execute(this.db);
    try {
      const value = await work();
      await sql`release savepoint form_action`.execute(this.db);
      return { ok: true, value };
    } catch (error) {
      await sql`rollback to savepoint form_action`.execute(this.db);
      return { ok: false, error };
    }
  }
}
