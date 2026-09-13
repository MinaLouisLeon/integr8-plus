import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import type { Selectable } from 'kysely';
import type { SubmissionsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Submission {
  id: string;
  tenantId: TenantId;
  formVersionId: string;
  answers: Record<string, unknown>;
  submittedBy: UserId;
  submittedAt: Date;
}

export interface CreateSubmissionInput {
  formVersionId: string;
  /** Already revalidated by `validateSubmission` from @integr8/form-engine. */
  answers: Record<string, unknown>;
  submittedBy: UserId | string;
}

/**
 * Submissions, bound to one published form version each.
 *
 * P06 needs only enough of this to make the binding real: a submission names
 * its version at insert, the database refuses a version that is not published,
 * and refuses to move a submission to another version afterwards. P08 adds the
 * lifecycle — drafts, reportable columns, amendment history.
 */
export class SubmissionsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `submissions` read is scoped. */
  #scoped() {
    return this.db.selectFrom('submissions').where('submissions.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateSubmissionInput): Promise<Submission> {
    const row = await this.db
      .insertInto('submissions')
      .values({
        tenant_id: this.tenantId,
        form_version_id: input.formVersionId,
        answers: input.answers,
        submitted_by: toUserId(input.submittedBy),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toDomain(row);
  }

  async findById(submissionId: string): Promise<Submission | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', submissionId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async listForVersion(formVersionId: string, limit = 100): Promise<Submission[]> {
    return (
      await this.#scoped()
        .selectAll()
        .where('form_version_id', '=', formVersionId)
        .orderBy('submitted_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toDomain);
  }
}

function toDomain(row: Selectable<SubmissionsTable>): Submission {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    formVersionId: row.form_version_id,
    answers: row.answers,
    submittedBy: toUserId(row.submitted_by),
    submittedAt: row.submitted_at,
  };
}
