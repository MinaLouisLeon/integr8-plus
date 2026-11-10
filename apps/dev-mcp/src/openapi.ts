import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { OPENAPI_FILE } from './paths.js';

/**
 * The API's routes, read from `apps/api/openapi.json` (generated from the
 * route registry), for `find_route`, `get_route` and checking a request before
 * it is sent. The permission, module and idempotency come from the document's
 * `x-integr8-*` fields.
 */

type Json = Record<string, unknown>;

export interface RouteInfo {
  method: string;
  /** OpenAPI form, `{param}`. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security: 'public' | 'bearer' | 'website_key';
  permission: string | null;
  anyPermission: string[];
  feature: string | null;
  idempotency: 'required' | 'honoured' | null;
  platformScopes: string[] | null;
  pathParams: string[];
  queryParams: { name: string; required: boolean; schema: Json }[];
  body: { contentType: string; schema: Json | null } | null;
  responses: Record<string, { description: string; schema: Json | null }>;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const record = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};

function toRoute(path: string, method: string, op: Json): RouteInfo {
  const parameters = (Array.isArray(op.parameters) ? op.parameters : []).map(record);
  const content = record(record(op.requestBody).content);
  const [contentType] = Object.keys(content);
  const security = Array.isArray(op.security) ? op.security.map(record) : [];
  return {
    method: method.toUpperCase(),
    path,
    operationId: str(op.operationId),
    summary: str(op.summary),
    description: str(op.description),
    tags: Array.isArray(op.tags) ? op.tags.map(String) : [],
    security: security.some((entry) => 'websiteKeyAuth' in entry)
      ? 'website_key'
      : security.length > 0
        ? 'bearer'
        : 'public',
    permission: typeof op['x-integr8-permission'] === 'string' ? op['x-integr8-permission'] : null,
    anyPermission: Array.isArray(op['x-integr8-any-permission'])
      ? op['x-integr8-any-permission'].map(String)
      : [],
    feature: typeof op['x-integr8-feature'] === 'string' ? op['x-integr8-feature'] : null,
    idempotency:
      op['x-integr8-idempotency'] === 'required' || op['x-integr8-idempotency'] === 'honoured'
        ? op['x-integr8-idempotency']
        : null,
    platformScopes: Array.isArray(op['x-integr8-platform-scopes'])
      ? op['x-integr8-platform-scopes'].map(String)
      : null,
    pathParams: parameters.filter((p) => p.in === 'path').map((p) => String(p.name)),
    queryParams: parameters
      .filter((p) => p.in === 'query')
      .map((p) => ({
        name: String(p.name),
        required: p.required === true,
        schema: record(p.schema),
      })),
    body:
      contentType === undefined
        ? null
        : {
            contentType,
            schema:
              Object.keys(record(record(content[contentType]).schema)).length === 0
                ? null
                : record(record(content[contentType]).schema),
          },
    responses: Object.fromEntries(
      Object.entries(record(op.responses)).map(([status, value]) => {
        const response = record(value);
        const json = record(record(response.content)['application/json']);
        return [
          status,
          {
            description: str(response.description),
            schema: Object.keys(record(json.schema)).length === 0 ? null : record(json.schema),
          },
        ];
      }),
    ),
  };
}

export class RouteIndex {
  readonly routes: RouteInfo[];

  constructor(document: Json) {
    this.routes = Object.entries(record(document.paths)).flatMap(([path, methods]) =>
      Object.entries(record(methods))
        .filter(([method]) => METHODS.includes(method))
        .map(([method, op]) => toRoute(path, method, record(op))),
    );
  }

  static load(file: string = OPENAPI_FILE): RouteIndex {
    return new RouteIndex(JSON.parse(readFileSync(file, 'utf8')) as Json);
  }

  /** Routes matching every word, best first: operation id, path, summary, tags, description. */
  search(query: string, options: { tag?: string; limit?: number } = {}): RouteInfo[] {
    const words = query
      .toLowerCase()
      .split(/\s+/u)
      .filter((word) => word !== '');
    const scored = this.routes
      .filter((route) => options.tag === undefined || route.tags.includes(options.tag))
      .map((route) => {
        const fields = [
          [route.operationId.toLowerCase(), 5],
          [`${route.method.toLowerCase()} ${route.path.toLowerCase()}`, 4],
          [route.summary.toLowerCase(), 3],
          [route.tags.join(' ').toLowerCase(), 2],
          [route.description.toLowerCase(), 1],
        ] as const;
        let score = 0;
        for (const word of words) {
          const best = Math.max(
            0,
            ...fields.map(([text, weight]) => (text.includes(word) ? weight : 0)),
          );
          if (best === 0) {
            return { route, score: -1 };
          }
          score += best;
        }
        return { route, score };
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.route.path.localeCompare(b.route.path));
    return scored.slice(0, options.limit ?? 20).map((entry) => entry.route);
  }

  /** By operation id, or by method and path (`{param}` or a concrete path). */
  find(selector: { operationId?: string; method?: string; path?: string }): RouteInfo | undefined {
    if (selector.operationId !== undefined) {
      return this.routes.find((route) => route.operationId === selector.operationId);
    }
    if (selector.method === undefined || selector.path === undefined) {
      return undefined;
    }
    const method = selector.method.toUpperCase();
    const path = selector.path.split('?')[0] ?? '';
    return (
      this.routes.find((route) => route.method === method && route.path === path) ??
      this.routes.find(
        (route) => route.method === method && matchPath(route.path, path) !== undefined,
      )
    );
  }
}

/** The parameters of a concrete path against a template, or undefined if it does not match. */
export function matchPath(template: string, path: string): Record<string, string> | undefined {
  const names: string[] = [];
  const pattern = template.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const found = new RegExp(`^${pattern}$`, 'u').exec(path);
  if (found === null) {
    return undefined;
  }
  return Object.fromEntries(
    names.map((name, index) => [name, decodeURIComponent(found[index + 1] ?? '')]),
  );
}

export interface RequestProblem {
  where: string;
  message: string;
}

/** Checks a request against its route before it is sent; an empty list means it fits. */
export function checkRequest(
  route: RouteInfo,
  request: { path: string; query?: Record<string, unknown>; body?: unknown },
): RequestProblem[] {
  const problems: RequestProblem[] = [];
  if (matchPath(route.path, request.path.split('?')[0] ?? '') === undefined) {
    problems.push({ where: 'path', message: `Fill every parameter of ${route.path}.` });
  }
  for (const parameter of route.queryParams) {
    if (parameter.required && request.query?.[parameter.name] === undefined) {
      problems.push({ where: `query.${parameter.name}`, message: 'Required.' });
    }
  }
  const known = new Set(route.queryParams.map((parameter) => parameter.name));
  for (const name of Object.keys(request.query ?? {})) {
    if (!known.has(name)) {
      problems.push({
        where: `query.${name}`,
        message: 'This route takes no such query parameter.',
      });
    }
  }
  if (
    route.body?.schema !== null &&
    route.body?.schema !== undefined &&
    route.body.contentType === 'application/json'
  ) {
    let schema: z.ZodType;
    try {
      schema = z.fromJSONSchema(route.body.schema, { defaultTarget: 'openapi-3.0' });
    } catch {
      return problems;
    }
    const result = schema.safeParse(request.body ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push({
          where: ['body', ...issue.path.map(String)].join('.'),
          message: issue.message,
        });
      }
    }
  }
  return problems;
}

/** One line for a search result. */
export const routeLine = (route: RouteInfo) =>
  `${route.method} ${route.path} — ${route.summary} (${route.operationId}${route.permission === null ? '' : `, ${route.permission}`})`;
