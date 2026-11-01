import { withTenant } from '@integr8/db';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { conflict } from './errors.js';
import type { HandlerResult, RequestContext } from './routes.js';

/**
 * Making a retried mutation happen once.
 *
 * The situation this exists for is not exotic. A phone on a marginal
 * connection sends "this job is complete", the connection drops, and from the
 * phone's side "it failed" and "it succeeded and the reply was lost" are the
 * same event. The only safe client behaviour is to retry — which is exactly
 * what the mobile outbox in P12 does — and without a dedupe record, retrying
 * books the work twice.
 *
 * Storing the response, rather than merely refusing the second attempt, is what
 * makes a replay invisible: the retry receives the original status and body, so
 * a client cannot tell whether it was the first caller.
 */

/**
 * The key request fingerprints are made with, derived from `PLATFORM_SECRET_KEY`.
 *
 * Derived rather than a setting of its own: every deployment already holds that
 * secret, and a fixed label makes this key useless for anything else it
 * protects. Changing `PLATFORM_SECRET_KEY` changes every fingerprint, which
 * costs no more than a retry within the next day being refused as reused.
 */
export function fingerprintKeyFrom(platformSecretKey: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(platformSecretKey, 'utf8'),
      Buffer.alloc(0),
      'integr8 idempotency request fingerprint v1',
      32,
    ),
  );
}

/**
 * A stable fingerprint of a request.
 *
 * Object keys are serialised in sorted order, so two JSON bodies that differ
 * only in key order fingerprint the same — otherwise a client that rebuilt its
 * payload between retries would look like it had changed the request.
 *
 * Keyed (HMAC-SHA256) and without the body's secrets ({@link withoutSecrets}).
 * It used to be a plain SHA-256 of the whole body, so the fingerprint stored
 * for Change password let anybody who read `idempotency_keys` test guesses at
 * the new password offline. Now a stored fingerprint says nothing without the
 * server's key, and a password never reaches it at all.
 */
export function fingerprintRequest(
  key: Buffer,
  method: string,
  path: string,
  body: unknown,
): string {
  return createHmac('sha256', key)
    .update(canonicalRequest(method, path, withoutSecrets(path, body)), 'utf8')
    .digest('hex');
}

/**
 * The fingerprint as it was made before {@link fingerprintRequest} was keyed.
 *
 * Only ever compared, never stored: a retry of a request first seen by the
 * previous release still matches its record rather than being refused as a
 * different request. Records last 24 hours and a phone's changes
 * `SYNC_REPLAY_DAYS`; once that long has passed since the keyed release went
 * out, this and its callers can go.
 */
export function legacyFingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(canonicalRequest(method, path, body), 'utf8')
    .digest('hex');
}

function canonicalRequest(method: string, path: string, body: unknown): string {
  return [method.toUpperCase(), path, canonicalise(body)].join('\n');
}

/** Field names that hold a password, a secret or a token, wherever they appear. */
const SECRET_FIELD = /password|secret|token$/iu;

/** Paths where `code` is a one-time sign-in code rather than, say, an item code. */
const SIGN_IN_PATH = /^\/v1\/(auth|me)\//u;

/** A one-time code's field name, on a sign-in path. */
const CODE_FIELD = /^(code|otp)$/iu;

/**
 * The body with every secret-bearing field left out, at any depth.
 *
 * Leaving one out means two requests that differ only in it fingerprint the
 * same: a retry that changed its password replays the first answer rather
 * than being refused. That is the right way round for a secret.
 */
export function withoutSecrets(path: string, body: unknown): unknown {
  const signIn = SIGN_IN_PATH.test(path);
  const strip = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(strip);
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([name]) => !SECRET_FIELD.test(name) && !(signIn && CODE_FIELD.test(name)))
        .map(([name, entry]) => [name, strip(entry)]),
    );
  };
  return strip(body);
}

function canonicalise(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalise).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalise(entry)}`);

  return `{${entries.join(',')}}`;
}

/**
 * Runs `execute` at most once per idempotency key.
 *
 * The claim and the completion are separate transactions from the handler's
 * own, deliberately. The claim has to be *committed* before the handler starts,
 * or a second request arriving a millisecond later would not see it and both
 * would run.
 */
export async function withIdempotency(
  context: RequestContext,
  request: { method: string; path: string; body: unknown },
  execute: () => Promise<HandlerResult<unknown>>,
): Promise<HandlerResult<unknown>> {
  const key = context.idempotencyKey;
  if (key === null || key === '') {
    return execute();
  }

  const fingerprint = fingerprintRequest(
    context.services.requestFingerprintKey,
    request.method,
    request.path,
    request.body,
  );
  const expiresAt = new Date(Date.now() + context.config.API_IDEMPOTENCY_TTL_SECONDS * 1000);

  const claim = await withTenant(context.principal.tenantId, (tx) =>
    tx.idempotency.claim({
      idempotencyKey: key,
      userId: context.principal.userId,
      method: request.method,
      path: request.path,
      requestFingerprint: fingerprint,
      alsoMatches: [legacyFingerprint(request.method, request.path, request.body)],
      expiresAt,
    }),
  );

  switch (claim.outcome) {
    case 'replay': {
      context.logger.info('Replayed an idempotent request', {
        idempotencyKeyPresent: true,
        originalStatus: claim.record.responseStatus,
      });

      return {
        status: claim.record.responseStatus ?? 200,
        body: claim.record.responseBody,
        // So a client can tell, if it wants to, that this was a replay. The
        // status and body are identical either way.
        headers: { 'idempotent-replay': 'true' },
      };
    }

    case 'in_progress': {
      // Two requests with the same key at the same time. Refusing the second is
      // the only correct answer: waiting for the first would tie up a
      // connection, and running it would defeat the point.
      throw conflict(
        'idempotency_key_in_progress',
        'A request with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }

    case 'fingerprint_mismatch': {
      // A client bug. Replaying the first response would hide it and silently
      // discard the second request.
      throw conflict(
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different request. Use a new key.',
      );
    }

    case 'claimed': {
      break;
    }
  }

  try {
    const result = await execute();

    // Server errors are not recorded: they are ours, they may be transient, and
    // a client retrying with the same key should get a real attempt rather than
    // a replayed 500.
    if (result.status < 500) {
      await withTenant(context.principal.tenantId, (tx) =>
        tx.idempotency.complete(key, { status: result.status, body: result.body }),
      );
    } else {
      await release(context, key);
    }

    return result;
  } catch (error) {
    // The key is released so the same key can be retried. Holding it would turn
    // one transient failure into a day of rejections for that client.
    await release(context, key);
    throw error;
  }
}

async function release(context: RequestContext, key: string): Promise<void> {
  try {
    await withTenant(context.principal.tenantId, (tx) => tx.idempotency.release(key));
  } catch (error) {
    // Releasing is best-effort cleanup. Failing here would replace the real
    // error with a less useful one.
    context.logger.warn('Could not release an idempotency claim', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
