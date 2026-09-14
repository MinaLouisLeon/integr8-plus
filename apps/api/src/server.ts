import { assertCan, PermissionDeniedError, type Principal } from '@integr8/core';
import { AuthError, InvalidTokenError } from '@integr8/auth';
import { getAuthDataSource } from '@integr8/db';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Services } from './composition.js';
import { type ApiConfig, corsOrigins } from './config.js';
import { registerCors } from './http/cors.js';
import { LocalDiskStorage, LOCAL_MEDIA_PREFIX } from './media/local-disk.js';
import { assessClientVersion, outdatedClientMessage } from './http/client-version.js';
import {
  ApiError,
  forbidden,
  internal,
  isClientError,
  notFound,
  tooManyRequests,
  unauthorised,
  validationError,
} from './http/errors.js';
import { withIdempotency } from './http/idempotency.js';
import { createLogger, type Logger, principalContext } from './http/logger.js';
import type { AnyRoute, ClientApp, PublicRequestContext, RequestContext } from './http/routes.js';
import { captureException } from './observability/sentry.js';

/**
 * The request pipeline.
 *
 * Ordered so that the cheapest rejection happens first and nothing expensive
 * runs for a request that was never going to be served:
 *
 *   1. context and request id  — so everything after it can be traced
 *   2. client version          — an unsupported build is told once, clearly
 *   3. per-IP rate limit       — before any database work
 *   4. validation              — before authentication, so a malformed request
 *                                is not also an authentication attempt
 *   5. authentication          — verify the token
 *   6. permission              — the matrix from @integr8/core
 *   7. per-tenant rate limit   — one noisy company must not starve another
 *   8. idempotency             — claim the key, then run the handler
 *
 * Validation before authentication is worth a word. It means an anonymous
 * caller can learn that a body is malformed, which is not a secret; the reverse
 * order would make every schema change a potential authentication oracle.
 */

export interface BuildServerOptions {
  config: ApiConfig;
  services: Services;
  routes: readonly AnyRoute[];
  logger?: Logger;
}

export function buildServer(options: BuildServerOptions): FastifyInstance {
  const { config, services, routes } = options;
  const logger =
    options.logger ??
    createLogger({
      level: config.APP_ENV === 'test' ? 'error' : 'info',
      service: 'integr8-api',
      release: config.API_RELEASE,
    });

  const app = Fastify({
    // Our own logger: Fastify's is excellent and does not know about tenants,
    // principals or impersonation, which are the fields that make a log line
    // answerable here.
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: config.API_MAX_BODY_BYTES,
    disableRequestLogging: true,
    trustProxy: true,
  });

  const limiter = createRateLimiter();

  // Before anything that could refuse a request: a preflight carries none of
  // the headers the later checks look for.
  registerCors(app, corsOrigins(config));

  // ---------------------------------------------------------------------------
  // 1. Context, and the headers every response carries
  // ---------------------------------------------------------------------------

  app.addHook('onRequest', (request, reply, done) => {
    const requestId = String(request.id);

    reply.header('x-request-id', requestId);
    reply.header('min-supported-client', config.API_MIN_SUPPORTED_CLIENT);
    reply.header('x-api-release', config.API_RELEASE);

    request.integr8 = {
      requestId,
      logger: logger.child({
        requestId,
        method: request.method,
        path: request.url,
      }),
      config,
      services,
      principal: null,
      ipAddress: request.ip === '' ? null : request.ip,
      userAgent: header(request, 'user-agent'),
      idempotencyKey: header(request, 'idempotency-key'),
      clientApp: readClientApp(header(request, 'x-client-app')),
      startedAt: process.hrtime.bigint(),
    };

    done();
  });

  // ---------------------------------------------------------------------------
  // 2. Is this client still supported?
  // ---------------------------------------------------------------------------

  app.addHook('onRequest', (request, _reply, done) => {
    // The health endpoints answer regardless: a load balancer sends no client
    // version, and a deployment that fails its own health check because of a
    // header policy is a bad afternoon.
    // Signed media links are followed by whatever fetched them — in production
    // they point at R2 and never reach this server — so they carry no client
    // headers and are authorised by their signature instead.
    if (
      request.url.startsWith('/health') ||
      request.url.startsWith('/openapi') ||
      request.url.startsWith(LOCAL_MEDIA_PREFIX)
    ) {
      done();
      return;
    }

    const verdict = assessClientVersion(
      header(request, 'x-client-version'),
      config.API_MIN_SUPPORTED_CLIENT,
    );

    if (verdict.supported) {
      done();
      return;
    }

    // 503 rather than 400: nothing is wrong with the request. The client is
    // simply older than this deployment serves, and `Retry-After` would be a
    // lie, so the message carries the actionable part.
    done(
      new ApiError(
        503,
        'client_too_old',
        outdatedClientMessage({
          minimum: verdict.minimum,
          declared: verdict.declared,
          updateUrl: config.API_UPDATE_URL,
        }),
        [
          { field: 'header.x-client-version', code: 'unsupported', message: verdict.declared },
          {
            field: 'header.min-supported-client',
            code: 'minimum',
            message: verdict.minimum,
          },
        ],
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // 3. Per-IP rate limit, before any database work
  // ---------------------------------------------------------------------------

  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/health')) {
      return;
    }

    const ip = request.integr8.ipAddress;
    if (ip === null) {
      return;
    }

    await limiter.consume({
      bucketKey: `ip:${ip}`,
      limit: config.API_IP_RATE_LIMIT,
      windowMs: config.API_IP_RATE_WINDOW_SECONDS * 1000,
      logger: request.integr8.logger,
    });
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  for (const route of routes) {
    app.route({
      method: route.method.toUpperCase(),
      url: route.path,
      ...(route.bodyLimit === undefined ? {} : { bodyLimit: route.bodyLimit }),
      handler: async (request, reply) => {
        const context = request.integr8;

        // 4. Validation.
        const params = parse(route.params, request.params, 'params');
        const query = parse(route.query, request.query, 'query');
        const body = parse(route.body, request.body ?? {}, 'body');

        // 5. Authentication.
        if (route.security === 'authenticated') {
          const principal = await authenticate(request, services);
          context.principal = principal;
          context.logger = context.logger.child(principalContext(principal));

          // An impersonation token is re-checked against its grant on every
          // request, so ending a session takes effect immediately rather than
          // whenever the access token happens to lapse.
          if (principal.impersonatedBy !== undefined) {
            await services.impersonation.assertStillPermitted(principal);
          }

          // 6. Permission.
          if (route.permission !== undefined) {
            try {
              assertCan(principal.role, route.permission);
            } catch (error) {
              if (error instanceof PermissionDeniedError) {
                throw forbidden(
                  `This action requires the "${error.permission}" permission, which a ${error.role} does not hold.`,
                );
              }
              throw error;
            }
          }

          // 7. Per-tenant rate limit. One noisy company must not starve
          // another, and this runs after authentication because until then
          // there is no company to attribute the request to.
          await limiter.consume({
            bucketKey: `tenant:${principal.tenantId}`,
            limit: config.API_TENANT_RATE_LIMIT,
            windowMs: config.API_TENANT_RATE_WINDOW_SECONDS * 1000,
            logger: context.logger,
          });
        }

        // 8. Idempotency, then the handler.
        const run = async () => route.handler({ params, query, body }, context);
        const result =
          route.idempotent === true && context.principal !== null
            ? await withIdempotency(
                context as RequestContext,
                { method: request.method, path: request.url, body },
                run,
              )
            : await run();

        for (const [name, value] of Object.entries(result.headers ?? {})) {
          reply.header(name, value);
        }

        return reply.status(result.status).send(result.body);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Failures
  // ---------------------------------------------------------------------------

  if (services.media instanceof LocalDiskStorage) {
    services.media.register(app, config.MEDIA_MAX_BYTES);
  }

  app.setNotFoundHandler((request, reply) => {
    const error = notFound(`No route matches ${request.method} ${request.url}`);
    return reply
      .status(error.status)
      .send(error.toResponse(request.integr8?.requestId ?? String(request.id)));
  });

  app.setErrorHandler((error, request, reply) => {
    const context: PublicRequestContext | undefined = request.integr8;
    const requestId = context?.requestId ?? String(request.id);
    const log = context?.logger ?? logger;

    const api = toApiError(error);

    for (const [name, value] of Object.entries(api.headers ?? {})) {
      reply.header(name, value);
    }

    if (isClientError(api)) {
      log.info('Request rejected', { status: api.status, code: api.code, reason: api.message });
    } else {
      log.error('Request failed', {
        status: api.status,
        code: api.code,
        reason: api.message,
        stack: error instanceof Error ? error.stack : undefined,
      });
      captureException(error, {
        requestId,
        ...(context === undefined ? {} : contextTags(context)),
      });
    }

    return reply.status(api.status).send(api.toResponse(requestId));
  });

  // ---------------------------------------------------------------------------
  // One line per request, carrying the same id the caller was given
  // ---------------------------------------------------------------------------

  app.addHook('onResponse', (request, reply, done) => {
    const context = request.integr8;
    if (context !== undefined) {
      context.logger.info('Request completed', {
        status: reply.statusCode,
        durationMs: Number(process.hrtime.bigint() - context.startedAt) / 1_000_000,
      });
    }
    done();
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value === undefined || value === '' ? null : value;
}

function readClientApp(raw: string | null): ClientApp {
  return raw === 'web' || raw === 'desktop' || raw === 'mobile' ? raw : 'api';
}

function parse<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  value: unknown,
  where: 'body' | 'query' | 'params',
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    throw validationError(where, result.error as Parameters<typeof validationError>[1]);
  }
  return result.data;
}

/**
 * Reads the bearer token and verifies it.
 *
 * Every failure — missing header, wrong scheme, malformed token, expired token,
 * revoked session — produces the same 401 with the same message. Telling a
 * caller which one it was tells an attacker how close they are.
 */
async function authenticate(request: FastifyRequest, services: Services): Promise<Principal> {
  const authorization = header(request, 'authorization');
  if (!authorization?.toLowerCase().startsWith('bearer ')) {
    throw unauthorised();
  }

  try {
    return await services.tokens.verifyAccessToken(authorization.slice(7).trim());
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      throw unauthorised();
    }
    throw error;
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof PermissionDeniedError) {
    return forbidden(error.message);
  }

  // Errors from @integr8/auth already carry a stable code and are safe to show.
  if (error instanceof AuthError) {
    return new ApiError(statusForAuthError(error.code), error.code, error.message);
  }

  // Fastify's own errors — an unparseable body, a body over the limit.
  const fastifyCode = (error as { code?: unknown }).code;
  if (
    fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
  ) {
    return new ApiError(400, 'invalid_body', 'The request body could not be read as JSON.');
  }
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return new ApiError(413, 'body_too_large', 'The request body is too large.');
  }
  if (typeof fastifyCode === 'string' && fastifyCode.startsWith('FST_ERR_CTP_')) {
    return new ApiError(400, 'invalid_body', 'The request body could not be read.');
  }

  // Anything else is ours, and its message was written for us rather than for a
  // stranger. It is logged in full and reported to Sentry; the caller gets the
  // request id and nothing more.
  return internal();
}

function statusForAuthError(code: string): number {
  switch (code) {
    case 'auth.rate_limited':
      return 429;
    case 'auth.account_locked':
      return 423;
    case 'auth.invalid_credentials':
    case 'auth.invalid_token':
    case 'auth.session_revoked':
    case 'auth.refresh_token_reuse':
      return 401;
    case 'auth.not_a_member':
    case 'auth.impersonation_denied':
      return 403;
    case 'auth.invitation_invalid':
    case 'auth.weak_password':
      return 422;
    case 'auth.identity_provider_unavailable':
      return 502;
    default:
      return 400;
  }
}

function contextTags(context: PublicRequestContext): Record<string, string> {
  return {
    ...(context.principal === null
      ? {}
      : { tenantId: context.principal.tenantId, userId: context.principal.userId }),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface ConsumeOptions {
  bucketKey: string;
  limit: number;
  windowMs: number;
  logger: Logger;
}

/**
 * Postgres-backed fixed windows, with an in-memory short circuit.
 *
 * The counter has to be shared, or the effective limit multiplies by the number
 * of containers. But an upsert per request is also a write per request an
 * attacker can force, so once a bucket is known to be over its limit the
 * decision is served from memory until that window ends. The common case costs
 * one cheap upsert; the abusive case costs nothing.
 *
 * If this becomes a contention point, the answer is Redis and it is a P19
 * conversation. It is one class and one interface, which is what makes that
 * swap small.
 */
function createRateLimiter() {
  const blockedUntil = new Map<string, number>();

  return {
    async consume(options: ConsumeOptions): Promise<void> {
      const now = Date.now();
      const blocked = blockedUntil.get(options.bucketKey);

      if (blocked !== undefined) {
        if (blocked > now) {
          throw tooManyRequests(
            'Too many requests. Slow down and try again shortly.',
            (blocked - now) / 1000,
          );
        }
        blockedUntil.delete(options.bucketKey);
      }

      let decision;
      try {
        const auth = await getAuthDataSource();
        decision = await auth.rateLimits.consume({
          bucketKey: options.bucketKey,
          limit: options.limit,
          windowMs: options.windowMs,
        });
      } catch (error) {
        // Fail open. A rate limiter that rejects everything when its store is
        // unreachable turns a degraded dependency into a full outage, and the
        // thing it protects against is abuse rather than correctness.
        options.logger.warn('Rate limiter unavailable; allowing the request', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!decision.allowed) {
        blockedUntil.set(options.bucketKey, decision.resetsAt.getTime());
        throw tooManyRequests(
          'Too many requests. Slow down and try again shortly.',
          (decision.resetsAt.getTime() - now) / 1000,
        );
      }
    },
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    integr8: PublicRequestContext & { startedAt: bigint };
  }
}
