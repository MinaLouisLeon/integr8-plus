import { assertSchemaUpToDate } from '@integr8/db';
import { z } from 'zod';
import { sentryEnabled } from '../observability/sentry.js';
import { ApiError } from '../http/errors.js';
import { defineRoute, noSchema } from '../http/routes.js';

/**
 * Liveness and readiness, which answer different questions.
 *
 * **Liveness** — is this process running? It touches nothing else, because an
 * orchestrator uses it to decide whether to *restart* the container, and
 * restarting a healthy API because its database is briefly unreachable turns a
 * database blip into an outage.
 *
 * **Readiness** — should this container receive traffic? It checks the things
 * a request needs, so a container that is up but not yet usable is kept out of
 * the load balancer rather than serving errors.
 *
 * Neither is for the internet. Caddy answers 404 for both on the public
 * address (deploy/vps/Caddyfile.example); Docker's health check and the
 * heartbeat script (deploy/vps/heartbeat.sh) call them on the machine itself.
 * Readiness reads the migration history over the API's own platform pool and
 * keeps its answer for {@link READINESS_CACHE_MS}, so calling it often costs one
 * query every ten seconds, not a connection per call.
 */

const livenessSchema = z.object({
  status: z.literal('ok'),
  release: z.string(),
  environment: z.string(),
});

const readinessSchema = z.object({
  status: z.enum(['ready', 'degraded']),
  release: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});

export const healthRoute = defineRoute({
  method: 'get',
  path: '/health',
  operationId: 'getHealth',
  summary: 'Liveness',
  description:
    'Answers while the process is running. Deliberately checks nothing else: an orchestrator restarts a container that fails this, and a brief database problem is not a reason to restart a healthy API.',
  tags: ['operations'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The process is running.', schema: livenessSchema } },
  handler: (_input, context) =>
    Promise.resolve({
      status: 200,
      body: {
        status: 'ok' as const,
        release: context.config.API_RELEASE,
        environment: context.config.APP_ENV,
      },
    }),
});

/** How long a readiness answer is reused before the checks run again. */
export const READINESS_CACHE_MS = 10_000;

interface ReadinessAnswer {
  status: 200 | 503;
  body: z.infer<typeof readinessSchema>;
}

let lastReadiness: { at: number; answer: ReadinessAnswer } | undefined;

/** Forgets the cached answer. For tests that change what readiness sees. */
export function resetReadinessCache(): void {
  lastReadiness = undefined;
}

export const readinessRoute = defineRoute({
  method: 'get',
  path: '/health/ready',
  operationId: 'getReadiness',
  summary: 'Readiness',
  description:
    'Answers whether this container should receive traffic. Checks the database is reachable and its schema matches this build, or is ahead of it after a rollback to an earlier release. The answer is reused for ten seconds. Not served on the public address: the proxy answers 404, and it is called from the machine itself.',
  tags: ['operations'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Ready to serve.', schema: readinessSchema },
    503: { description: 'Not ready.', schema: readinessSchema },
  },
  handler: async (_input, context) => {
    const now = Date.now();
    if (lastReadiness !== undefined && now - lastReadiness.at < READINESS_CACHE_MS) {
      return lastReadiness.answer;
    }

    const checks: { name: string; ok: boolean; detail?: string }[] = [];

    // A container whose build expects a table the database does not have will
    // fail on the first request that needs it, which is a confusing error at a
    // bad moment. Better to stay out of the load balancer and say why.
    // A schema ahead of this build is the opposite case: an earlier release
    // rolled back to, running on the newer schema as expand/contract promises.
    // It is ready, and the note says the code and schema are from different
    // releases so nobody forgets to go forward again.
    try {
      const { aheadOfBuild } = await assertSchemaUpToDate();
      checks.push(
        aheadOfBuild.length === 0
          ? { name: 'schema', ok: true }
          : {
              name: 'schema',
              ok: true,
              detail: `Ahead of this build: a newer release applied ${aheadOfBuild.join(', ')}`,
            },
      );
    } catch (error) {
      checks.push({
        name: 'schema',
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    checks.push({
      name: 'error-reporting',
      ok: sentryEnabled() || context.config.APP_ENV !== 'production',
      ...(sentryEnabled() ? {} : { detail: 'Sentry is not configured' }),
    });

    const ready = checks.every((check) => check.ok);

    const answer: ReadinessAnswer = {
      status: ready ? 200 : 503,
      body: {
        status: ready ? 'ready' : 'degraded',
        release: context.config.API_RELEASE,
        checks,
      },
    };
    lastReadiness = { at: now, answer };
    return answer;
  },
});

/**
 * Raises an error on purpose, so the path from a thrown exception to a Sentry
 * event can be proven rather than assumed.
 *
 * Registered outside production. P05's exit criteria ask for the same thing in
 * each client, and "we believe reporting works" is not the same claim as
 * "somebody has seen an event arrive".
 */
export const sentryProbeRoute = defineRoute({
  method: 'post',
  path: '/health/probe-error',
  operationId: 'probeError',
  summary: 'Raise a deliberate error',
  description:
    'Throws, so that error reporting can be verified end to end. Not registered in production.',
  tags: ['operations'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 500: { description: 'Always.' } },
  handler: () => {
    throw new ApiError(500, 'deliberate_probe', 'A deliberate error, raised to test reporting.');
  },
});

export function healthRoutes(environment: string) {
  return environment === 'production'
    ? [healthRoute, readinessRoute]
    : [healthRoute, readinessRoute, sentryProbeRoute];
}
