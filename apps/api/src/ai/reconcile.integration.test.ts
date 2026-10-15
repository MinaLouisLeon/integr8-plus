import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy, toUserId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { type ApiHarness, type Member, startApi } from '../testing/api-harness.js';
import { admitMessage } from './admission.js';
import { periodKeysAt } from './periods.js';
import { runAiReconciliation } from './reconcile.js';

/**
 * The reconciler (docs/ai §12; Phase F): what a crashed worker or a lost
 * provider answer leaves behind is put right by the next maintenance turn,
 * and nothing is charged twice or held open for ever.
 */

let api: ApiHarness;
let owner: Member;

const HELP: AiPolicy = { ...AI_POLICY_OFF, level: 'help', quotaMode: 'daily', dailyLimit: 10 };
const logger = createLogger({ level: 'error', write: () => undefined });

const principalOf = (member: Member) => ({
  userId: toUserId(member.userId),
  tenantId: api.tenantId as never,
  role: member.role,
  grants: [],
  sessionId: randomUUID(),
  tokenId: randomUUID(),
  expiresAt: new Date(Date.now() + 60_000),
});

async function conversation(): Promise<string> {
  return withTenant(api.tenantId, async (tx) => {
    const created = await tx.aiConversations.create({
      userId: owner.userId,
      locale: 'en',
      level: 'help',
    });
    return created.id;
  });
}

/** A slot claimed long enough ago that its reservation has already expired. */
async function staleClaim(conversationId: string, clientRequestId: string, at: Date) {
  return admitMessage({
    principal: principalOf(owner),
    conversationId,
    clientRequestId,
    requestFingerprint: 'f'.repeat(64),
    policy: HELP,
    worstCaseCostMicrousd: 1_000,
    config: api.config,
    now: at,
  });
}

async function countersAt(at: Date) {
  const counters = await withTenant(api.tenantId, (tx) =>
    tx.aiUsage.counters(owner.userId, periodKeysAt(at)),
  );
  const tenantDay = counters.find(
    (counter) => counter.subject === 'tenant' && counter.period === 'day',
  );
  return { used: tenantDay?.used ?? 0, reserved: tenantDay?.reserved ?? 0 };
}

beforeAll(async () => {
  api = await startApi({
    env: {
      AI_ENABLED: 'true',
      AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '1000000000',
      AI_RESERVATION_TTL_SECONDS: '1',
    },
  });
  owner = await api.member('owner', 'ai-reconcile-owner');
});

afterAll(async () => {
  await api.close();
});

describe('stale reservations', () => {
  it('releases a slot nobody answered, and charges one whose answer was stored', async () => {
    // Yesterday's claims, so this suite's counters are its own, whatever the
    // other suites did today.
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const conversationId = await conversation();
    const before = await countersAt(at);

    const abandoned = await staleClaim(conversationId, 'stale-abandoned', at);
    const answered = await staleClaim(conversationId, 'stale-answered', at);
    expect(abandoned.outcome).toBe('claimed');
    expect(answered.outcome).toBe('claimed');
    const answer = await withTenant(api.tenantId, (tx) =>
      tx.aiConversations.appendMessage({
        conversationId,
        userId: null,
        role: 'assistant',
        content: 'Open the work orders screen.',
        usageReservationId: answered.reservation.id,
      }),
    );
    // The worker died between storing that answer and settling its slot.
    expect((await countersAt(at)).reserved).toBe(before.reserved + 2);

    const report = await runAiReconciliation({ config: api.config, logger, workerId: 'test' });
    expect(report.failures).toEqual([]);
    expect(report.released).toBeGreaterThanOrEqual(1);
    expect(report.charged).toBeGreaterThanOrEqual(1);

    const rows = await withTenant(api.tenantId, async (tx) => ({
      abandoned: await tx.aiUsage.find(abandoned.reservation.id),
      answered: await tx.aiUsage.find(answered.reservation.id),
    }));
    expect(rows.abandoned?.state).toBe('expired');
    expect(rows.answered?.state).toBe('completed');
    expect(rows.answered?.responseMessageId).toBe(answer.id);

    // The abandoned slot is free again; the answered one is one message used.
    const after = await countersAt(at);
    expect(after.reserved).toBe(before.reserved);
    expect(after.used).toBe(before.used + 1);

    // Running again finds nothing of ours to do.
    const again = await runAiReconciliation({ config: api.config, logger, workerId: 'test' });
    expect(await withTenant(api.tenantId, (tx) => tx.aiUsage.listStale(new Date()))).toHaveLength(
      0,
    );
    expect(again.failures).toEqual([]);
  });
});

describe('the daily sweep', () => {
  it('expires proposals past their time and removes deleted conversations', async () => {
    const conversationId = await conversation();
    const now = new Date();
    const proposal = await withTenant(api.tenantId, (tx) =>
      tx.aiActions.create({
        userId: owner.userId,
        conversationId,
        toolKey: 'prepare_create_customer',
        typedPayload: { name: 'Late Ltd' },
        payloadSchemaVersion: 1,
        displaySummary: { title: 'Create customer', fields: [], warnings: [] },
        requestDigest: 'd'.repeat(64),
        resourceVersions: {},
        expiresAt: new Date(now.getTime() - 1_000),
      }),
    );
    const deleted = await conversation();
    expect(
      await withTenant(api.tenantId, (tx) =>
        tx.aiConversations.softDeleteForUser(deleted, owner.userId),
      ),
    ).toBe(true);

    const report = await runAiReconciliation({
      config: api.config,
      logger,
      workerId: 'test',
      now,
      force: true,
    });
    expect(report.failures).toEqual([]);
    expect(report.expiredProposals).toBeGreaterThanOrEqual(1);
    expect(report.sweptConversations).toBeGreaterThanOrEqual(1);

    const state = await withTenant(api.tenantId, async (tx) => ({
      proposal: (await tx.aiActions.findForUser(proposal.id, owner.userId))?.state,
      gone: await tx.aiConversations.findForUser(deleted, owner.userId),
      kept: await tx.aiConversations.findForUser(conversationId, owner.userId),
    }));
    expect(state.proposal).toBe('expired');
    expect(state.gone).toBeUndefined();
    expect(state.kept).toBeDefined();
  });
});
