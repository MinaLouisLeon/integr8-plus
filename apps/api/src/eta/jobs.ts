import { withTenant } from '@integr8/db';
import { EtaApiError } from '@integr8/eta/node';
import type { ApiConfig } from '../config.js';
import { isFeatureEnabled } from '../http/features.js';
import type { Logger } from '../http/logger.js';
import {
  checkStatus,
  ETA_RECONCILE_QUEUE,
  storedErrors,
  submissionFailureState,
} from './documents.js';
import { type EtaServices, openEtaClient } from './services.js';

/**
 * The two background jobs of e-invoicing (PLAN §3).
 *
 * `eta.submit` sends one signed document, once. It runs at most twice: the
 * second run only happens when the first died after the document was marked
 * `submitting`, and it never sends again — it marks the document `unknown`
 * for a person to resolve, because the first may have reached the ETA.
 *
 * `eta.reconcile` asks for a submitted document's status, with backoff,
 * until the ETA gives a final answer or the checks run out. A 200 from the
 * submission is never taken as validity.
 *
 * Neither runs for a company whose e-invoicing Integr8 has switched off: a
 * submission waiting to go is marked not sent (`feature_disabled`), and status
 * checks stop until a person asks again with the module back on. Another
 * process may take up to the module cache's half a minute to see the switch.
 *
 * Neither logs credentials, tokens or document contents: ids, states and
 * error codes only.
 */

export const ETA_SUBMIT_ATTEMPTS = 2;

interface Deps {
  config: ApiConfig;
  eta: EtaServices;
}

export async function runSubmission(
  deps: Deps,
  job: { tenantId: string; documentId: string; attempt: number; actorId: string | null },
  logger: Logger,
): Promise<string> {
  const moduleOn = await isFeatureEnabled(job.tenantId, 'e_invoicing');
  const loaded = await withTenant(job.tenantId, async (tx) => {
    const document = await tx.eta.document(job.documentId);
    if (document?.state !== 'submitting') {
      return { skip: document?.state ?? 'missing' } as const;
    }
    if (!moduleOn) {
      // Nothing has been sent yet: that only happens below, after this check.
      await tx.eta.transition(document.id, ['submitting'], 'failed', {
        lastErrorCode: 'feature_disabled',
      });
      return { skip: 'feature_disabled' } as const;
    }
    if (job.attempt > 1) {
      await tx.eta.transition(document.id, ['submitting'], 'unknown', {
        lastErrorCode: 'eta_submission_interrupted',
      });
      return { skip: 'interrupted' } as const;
    }
    const texts = await tx.eta.documentTexts(document.id);
    const settings = await tx.eta.settings();
    const opened = openEtaClient(deps, job.tenantId, settings, await tx.eta.sealedCredentials());
    if ('problem' in opened || texts?.signed === null || texts === undefined) {
      const code = 'problem' in opened ? opened.problem : 'eta_document_unsigned';
      await tx.eta.transition(document.id, ['submitting'], 'failed', { lastErrorCode: code });
      await tx.eta.recordAttempt({
        documentId: document.id,
        kind: 'submit',
        outcome: 'error',
        errorCode: code,
        startedAt: new Date(),
        actorId: job.actorId,
      });
      return { skip: code } as const;
    }
    if (document.environment !== settings.environment) {
      await tx.eta.transition(document.id, ['submitting'], 'failed', {
        lastErrorCode: 'eta_environment_changed',
      });
      return { skip: 'eta_environment_changed' } as const;
    }
    return { document, signed: texts.signed, client: opened.client } as const;
  });
  if ('skip' in loaded) {
    logger.info('ETA submission skipped', { documentId: job.documentId, reason: loaded.skip });
    return loaded.skip;
  }

  const { document, signed, client } = loaded;
  const startedAt = new Date();
  try {
    const result = await client.submit([signed]);
    const accepted =
      result.accepted.find((entry) => entry.internalId === document.internalId) ??
      (result.accepted.length === 1 && result.rejected.length === 0
        ? result.accepted[0]
        : undefined);
    const rejected =
      accepted === undefined
        ? (result.rejected.find((entry) => entry.internalId === document.internalId) ??
          (result.rejected.length === 1 ? result.rejected[0] : undefined))
        : undefined;
    return await withTenant(job.tenantId, async (tx) => {
      if (accepted !== undefined && accepted.uuid !== '') {
        const now = new Date();
        const moved = await tx.eta.transition(document.id, ['submitting'], 'submitted', {
          etaUuid: accepted.uuid,
          etaLongId: accepted.longId,
          submissionId: result.submissionId,
          etaStatus: 'Submitted',
          submittedAt: now,
          checks: 0,
          errors: [],
          lastErrorCode: null,
          nextCheckAt: new Date(now.getTime() + 15_000),
        });
        await tx.eta.recordAttempt({
          documentId: document.id,
          kind: 'submit',
          outcome: 'accepted',
          httpStatus: 202,
          correlationId: result.correlationId,
          startedAt,
          actorId: job.actorId,
        });
        if (moved !== undefined) {
          await tx.jobs.enqueue({
            queue: ETA_RECONCILE_QUEUE,
            payload: { documentId: document.id },
            availableAt: moved.nextCheckAt ?? now,
            maxAttempts: 3,
          });
        }
        return 'submitted';
      }
      if (rejected !== undefined) {
        await tx.eta.transition(document.id, ['submitting'], 'rejected', {
          submissionId: result.submissionId,
          errors: storedErrors([rejected.error, ...rejected.error.details]),
          lastErrorCode: 'eta_document_rejected',
          finalAt: new Date(),
        });
        await tx.eta.recordAttempt({
          documentId: document.id,
          kind: 'submit',
          outcome: 'rejected',
          httpStatus: 202,
          errorCode: rejected.error.code,
          message: rejected.error.message,
          correlationId: result.correlationId,
          startedAt,
          actorId: job.actorId,
        });
        return 'rejected';
      }
      // An answer that names neither: nobody knows what the ETA did with it.
      await tx.eta.transition(document.id, ['submitting'], 'unknown', {
        submissionId: result.submissionId,
        lastErrorCode: 'eta_answer_unclear',
      });
      await tx.eta.recordAttempt({
        documentId: document.id,
        kind: 'submit',
        outcome: 'unknown',
        httpStatus: 202,
        correlationId: result.correlationId,
        startedAt,
        actorId: job.actorId,
      });
      return 'unknown';
    });
  } catch (error) {
    if (!(error instanceof EtaApiError)) {
      throw error;
    }
    const state = submissionFailureState(error);
    await withTenant(job.tenantId, async (tx) => {
      await tx.eta.transition(document.id, ['submitting'], state, {
        lastErrorCode: `eta_${error.kind}`,
        errors: storedErrors(
          error.details.length > 0
            ? error.details
            : [{ code: error.code, message: error.message, target: null }],
        ),
      });
      await tx.eta.recordAttempt({
        documentId: document.id,
        kind: 'submit',
        outcome: state === 'unknown' ? 'unknown' : 'error',
        httpStatus: error.status,
        errorCode: error.code ?? error.kind,
        message: error.message,
        correlationId: error.correlationId,
        startedAt,
        actorId: job.actorId,
      });
    });
    logger.warn('ETA submission did not go through', {
      documentId: document.id,
      kind: error.kind,
      status: error.status,
      state,
    });
    return state;
  }
}

export async function runReconcile(
  deps: Deps,
  job: { tenantId: string; documentId: string; watchCancellation: boolean },
  logger: Logger,
): Promise<string> {
  const moduleOn = await isFeatureEnabled(job.tenantId, 'e_invoicing');
  return withTenant(job.tenantId, async (tx) => {
    const document = await tx.eta.document(job.documentId);
    if (document === undefined || !['submitted', 'valid'].includes(document.state)) {
      return 'nothing_to_check';
    }
    if (document.state === 'valid' && !job.watchCancellation) {
      return 'nothing_to_check';
    }
    if (!moduleOn) {
      // Switched off by Integr8: stop asking. "Check status now" asks again
      // once it is back on.
      await tx.eta.transition(document.id, [document.state], document.state, {
        nextCheckAt: null,
        lastErrorCode: 'feature_disabled',
      });
      return 'feature_disabled';
    }
    const settings = await tx.eta.settings();
    const opened = openEtaClient(deps, job.tenantId, settings, await tx.eta.sealedCredentials(), {
      requireEnabled: false,
    });
    if ('problem' in opened) {
      // Nothing to ask with. The document waits for a person to sync it.
      await tx.eta.transition(document.id, [document.state], document.state, {
        nextCheckAt: null,
        lastErrorCode: opened.problem,
      });
      return opened.problem;
    }
    const outcome = await checkStatus(tx, opened.client, document, {
      maxChecks: deps.config.ETA_MAX_STATUS_CHECKS,
      actorId: null,
      watchCancellation: job.watchCancellation,
    });
    if (outcome.again && outcome.document.nextCheckAt !== null) {
      await tx.jobs.enqueue({
        queue: ETA_RECONCILE_QUEUE,
        payload: { documentId: document.id, watchCancellation: job.watchCancellation },
        availableAt: outcome.document.nextCheckAt,
        maxAttempts: 3,
      });
    }
    logger.info('ETA status checked', {
      documentId: document.id,
      state: outcome.document.state,
      checks: outcome.document.checks,
    });
    return outcome.document.state;
  });
}
