import { z } from 'zod';
import { errorResponseSchema } from './errors.js';
import { type AnyRoute, pathParameterNames, toOpenApiPath } from './routes.js';

/**
 * The OpenAPI document, generated from the route registry.
 *
 * Generated rather than hand-written for one reason: a hand-written spec is
 * wrong within a month. Three clients are generated from this document, one of
 * them shipped as a signed binary, so a spec that disagrees with the server is
 * a compile-time lie that becomes a runtime failure on somebody's phone.
 *
 * Zod 4 converts schemas to JSON Schema natively, so there is no second schema
 * language and no annotation layer to keep in step.
 */

export interface OpenApiOptions {
  title: string;
  version: string;
  description?: string;
  servers: { url: string; description?: string }[];
  /** The oldest client build this deployment serves; documented, not just sent. */
  minSupportedClient: string;
}

export function buildOpenApiDocument(
  routes: readonly AnyRoute[],
  options: OpenApiOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = toOpenApiPath(route.path);
    paths[path] ??= {};
    paths[path][route.method] = operation(route);
  }

  return {
    openapi: '3.0.3',
    info: {
      title: options.title,
      version: options.version,
      description: [
        options.description ?? '',
        '',
        '## Versioning',
        '',
        'Every path is prefixed `/v1`. Nothing breaking ships inside a version:',
        'a field may be added, an enum may gain a value, an endpoint may appear.',
        'Removing a field, renaming one, narrowing a type or making an optional',
        'field required is a `/v2`.',
        '',
        'This is not a style rule. A signed desktop binary and an App Store',
        'build cannot be force-updated, so at any moment some traffic comes from',
        'software written months ago and still under support.',
        '',
        '## Headers',
        '',
        'Every response carries `x-request-id`; quote it when reporting a problem.',
        'Every response carries `min-supported-client`, the oldest client build',
        `this deployment serves (currently \`${options.minSupportedClient}\`).`,
        'Send `x-client-version` and `x-client-app` so the server can tell you to',
        'update before a call fails for a reason you cannot diagnose.',
        '',
        'Mutating endpoints marked idempotent accept `Idempotency-Key`. Replaying',
        'a request with the same key returns the original response and repeats no',
        'effect.',
      ].join('\n'),
    },
    servers: options.servers,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'The access token from `POST /v1/auth/sign-in`. Fifteen minutes.',
        },
      },
      schemas: {
        Error: toJsonSchema(errorResponseSchema, 'output'),
      },
    },
    paths,
  };
}

function operation(route: AnyRoute): Record<string, unknown> {
  const parameters: Record<string, unknown>[] = [];

  for (const name of pathParameterNames(route.path)) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: propertySchema(route.params, name) ?? { type: 'string' },
    });
  }

  const query = toJsonSchema(route.query, 'input');
  for (const [name, schema] of Object.entries(properties(query))) {
    parameters.push({
      name,
      in: 'query',
      required: required(query).includes(name),
      schema,
    });
  }

  if (route.idempotent === true) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string', maxLength: 255 },
      description:
        'A client-generated key. Replaying a request with the same key returns the original response and repeats no effect.',
    });
  }

  const hasBody = route.method !== 'get' && route.method !== 'delete' && !isEmpty(route.body);

  return {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description === undefined ? {} : { description: route.description }),
    tags: route.tags,
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(hasBody
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: toJsonSchema(route.body, 'input') } },
          },
        }
      : {}),
    responses: responses(route),
    ...(route.security === 'authenticated' ? { security: [{ bearerAuth: [] }] } : {}),
  };
}

/**
 * The declared responses, plus the failures every route can produce.
 *
 * Added here rather than repeated on each route: a client generated from this
 * document should know that any call can be rate-limited or can fail, and
 * writing that out forty times would guarantee some route forgot one.
 */
function responses(route: AnyRoute): Record<string, unknown> {
  const declared: Record<string, unknown> = {};

  for (const [status, response] of Object.entries(route.responses)) {
    declared[status] = {
      description: response.description,
      ...(response.schema === undefined
        ? {}
        : {
            content: {
              'application/json': { schema: toJsonSchema(response.schema, 'output') },
            },
          }),
    };
  }

  const error = { $ref: '#/components/schemas/Error' };
  const universal: Record<string, unknown> = {
    '422': { description: 'The request failed validation.', content: json(error) },
    '429': { description: 'Rate limit exceeded.', content: json(error) },
    '500': { description: 'Something went wrong on our side.', content: json(error) },
    '503': {
      description: 'This client build is older than the minimum supported.',
      content: json(error),
    },
  };

  if (route.security === 'authenticated') {
    universal['401'] = { description: 'Authentication is required.', content: json(error) };
    universal['403'] = {
      description: 'The caller lacks the required permission.',
      content: json(error),
    };
  }

  if (route.idempotent === true) {
    universal['409'] = {
      description:
        'The idempotency key is in use by a request still running, or was reused with a different body.',
      content: json(error),
    };
  }

  return { ...universal, ...declared };
}

function json(schema: unknown): Record<string, unknown> {
  return { 'application/json': { schema } };
}

/**
 * Zod to JSON Schema.
 *
 * `io` matters: a schema with a default is optional on the way in and always
 * present on the way out, and a client generated from the wrong one either
 * forces callers to send defaults or lets them treat a guaranteed field as
 * possibly missing.
 */
function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io,
    unrepresentable: 'any',
  });
}

function properties(schema: Record<string, unknown>): Record<string, unknown> {
  const found = schema.properties;
  return found !== null && typeof found === 'object' ? (found as Record<string, unknown>) : {};
}

function required(schema: Record<string, unknown>): string[] {
  const found = schema.required;
  return Array.isArray(found) ? found.map(String) : [];
}

function propertySchema(schema: z.ZodType, name: string): unknown {
  return properties(toJsonSchema(schema, 'input'))[name];
}

function isEmpty(schema: z.ZodType): boolean {
  return Object.keys(properties(toJsonSchema(schema, 'input'))).length === 0;
}
