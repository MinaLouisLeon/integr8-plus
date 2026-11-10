import { type TenantId, toTenantId } from '@integr8/core';
import type { Kysely, Selectable } from 'kysely';
import type { Database, TestOutboxChannel, TestOutboxTable } from '../schema.js';

/**
 * What test companies would have sent (0077, P38).
 *
 * A test company emails and pushes nothing; the API writes each message here
 * instead, so the developer MCP server can read back "the customer would have
 * been emailed the PDF". On the platform data source because the senders run
 * outside any one request's company (the worker's jobs, sign-in codes), and
 * kept 7 days by the worker's retention job.
 */

export interface TestOutboxEntry {
  id: string;
  tenantId: TenantId;
  channel: TestOutboxChannel;
  recipient: string;
  subject: string | null;
  body: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordTestOutboxInput {
  tenantId: TenantId | string;
  channel: TestOutboxChannel;
  recipient: string;
  subject?: string | null;
  body: string;
  details?: Record<string, unknown>;
}

/** How long an entry is kept: long enough for a day's testing and the morning after. */
export const TEST_OUTBOX_RETENTION_DAYS = 7;

const BODY_LIMIT = 100_000;

export class TestOutboxRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async record(input: RecordTestOutboxInput): Promise<TestOutboxEntry> {
    const row = await this.db
      .insertInto('test_outbox')
      .values({
        tenant_id: toTenantId(input.tenantId),
        channel: input.channel,
        recipient: input.recipient.slice(0, 320) || '(nobody)',
        subject: input.subject?.slice(0, 500) ?? null,
        body: input.body.slice(0, BODY_LIMIT),
        details: input.details ?? {},
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEntry(row);
  }

  /** Newest first. */
  async list(
    tenantId: TenantId | string,
    options: { since?: Date; channel?: TestOutboxChannel; limit?: number } = {},
  ): Promise<TestOutboxEntry[]> {
    let query = this.db
      .selectFrom('test_outbox')
      .selectAll()
      .where('tenant_id', '=', toTenantId(tenantId))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
    if (options.since !== undefined) {
      query = query.where('created_at', '>=', options.since);
    }
    if (options.channel !== undefined) {
      query = query.where('channel', '=', options.channel);
    }
    return (await query.execute()).map(toEntry);
  }

  /** Deletes what is older than the retention; returns how many went. */
  async deleteOlderThan(before: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('test_outbox')
      .where('created_at', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

function toEntry(row: Selectable<TestOutboxTable>): TestOutboxEntry {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    details: row.details,
    createdAt: row.created_at,
  };
}
