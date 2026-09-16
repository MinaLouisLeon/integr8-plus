import type { Permission, PlatformPrincipal, Principal } from '@integr8/core';
import { z } from 'zod';
import type { Services } from '../composition.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from './logger.js';

/**
 * One declaration per endpoint, used twice.
 *
 * Fastify registers it, and the OpenAPI document is generated from the same
 * object — so the published contract cannot drift from the code, because there
 * is nothing for it to drift from. A route whose schema changed and whose spec
 * did not is not a mistake that can be made here.
 *
 * The alternative was decorators over handler classes. This is more literal:
 * the whole contract for an endpoint is one value a reviewer reads top to
 * bottom, including who may call it and whether it is idempotent.
 */

export type ClientApp = 'web' | 'desktop' | 'mobile' | 'api';

export interface BaseRequestContext {
  requestId: string;
  logger: Logger;
  config: ApiConfig;
  services: Services;
  ipAddress: string | null;
  userAgent: string | null;
  /** The `Idempotency-Key` header, if the caller sent one. */
  idempotencyKey: string | null;
  clientApp: ClientApp;
}

/** What an authenticated handler receives. `principal` is not nullable here. */
export interface RequestContext extends BaseRequestContext {
  principal: Principal;
}

/** What a public handler receives: a principal only if one happened to be sent. */
export interface PublicRequestContext extends BaseRequestContext {
  principal: Principal | null;
  /** Set only on `platform` routes; see {@link PlatformRequestContext}. */
  platform?: PlatformPrincipal;
}

/**
 * What a platform handler receives (P15).
 *
 * `platform` rather than `principal`, and a different type, so the two can
 * never be confused: a platform request has no company, so there is nothing for
 * `assertCan` or a tenant repository to read from it, and the compiler says so
 * rather than a null check at runtime.
 */
export interface PlatformRequestContext extends BaseRequestContext {
  principal: null;
  platform: PlatformPrincipal;
}

export interface HandlerResult<T> {
  status: number;
  body: T;
  headers?: Record<string, string>;
}

export interface RouteResponse {
  description: string;
  schema?: z.ZodType;
  /** When the body is not JSON — a CSV export. The handler returns the body as a string. */
  contentType?: string;
}

export type RouteSecurity = 'public' | 'authenticated' | 'platform';

interface RouteShape {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Fastify form, with `:param`. Converted to `{param}` for OpenAPI. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];

  /**
   * `public` routes run before authentication; `authenticated` ones receive a
   * verified principal; `platform` ones receive a super admin and no company
   * at all (P15).
   *
   * Never a boolean, for exactly the reason the third kind now demonstrates.
   */
  security: RouteSecurity;

  /** Checked after authentication, against the permission matrix in core. */
  permission?: Permission;

  /**
   * Whether this endpoint honours `Idempotency-Key`.
   *
   * Declared per route rather than inferred from the verb: a POST that only
   * reads needs no dedupe row, and one that charges money needs it whatever
   * verb it uses.
   */
  idempotent?: boolean;

  /** Largest request body, in bytes, where this route needs more than `API_MAX_BODY_BYTES` — a CSV import. */
  bodyLimit?: number;

  params: z.ZodType;
  query: z.ZodType;
  body: z.ZodType;

  responses: Record<number, RouteResponse>;
}

/**
 * A route after its generics have been erased.
 *
 * The registry holds these; the type parameters exist only to check the handler
 * against its own schemas at the point it is written.
 */
export interface AnyRoute extends RouteShape {
  handler: (
    input: { params: unknown; query: unknown; body: unknown },
    context: PublicRequestContext,
  ) => Promise<HandlerResult<unknown>>;
}

interface TypedRoute<
  TSecurity extends RouteSecurity,
  TParams extends z.ZodType,
  TQuery extends z.ZodType,
  TBody extends z.ZodType,
  TResult,
> extends RouteShape {
  security: TSecurity;
  params: TParams;
  query: TQuery;
  body: TBody;
  handler: (
    input: { params: z.infer<TParams>; query: z.infer<TQuery>; body: z.infer<TBody> },
    context: TSecurity extends 'authenticated'
      ? RequestContext
      : TSecurity extends 'platform'
        ? PlatformRequestContext
        : PublicRequestContext,
  ) => Promise<HandlerResult<TResult>>;
}

/**
 * Declares a route, inferring the handler's argument types from the schemas
 * beside it.
 *
 * The returned value is erased to {@link AnyRoute} because the registry is a
 * heterogeneous list and a list cannot keep every element's parameters. The
 * cast is confined to this function: the author gets full checking, and the
 * plugin that runs routes gets one uniform shape. Every value the handler
 * actually receives has been parsed by the schemas declared here, so the
 * erasure loses nothing at runtime.
 */
export function defineRoute<
  TSecurity extends RouteSecurity,
  TParams extends z.ZodType,
  TQuery extends z.ZodType,
  TBody extends z.ZodType,
  TResult,
>(route: TypedRoute<TSecurity, TParams, TQuery, TBody, TResult>): AnyRoute {
  return route as unknown as AnyRoute;
}

/** The empty schema, for the many routes with no parameters and no body. */
export const noSchema = z.object({});

/**
 * `/v1/sessions/:sessionId` → `/v1/sessions/{sessionId}`.
 *
 * Fastify and OpenAPI disagree about path parameters, and one declaration has
 * to serve both.
 */
export function toOpenApiPath(path: string): string {
  return path.replaceAll(/:([A-Za-z0-9_]+)/gu, '{$1}');
}

/** The path parameter names a route declares, in order. */
export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/gu)].map((match) => match[1] ?? '');
}
