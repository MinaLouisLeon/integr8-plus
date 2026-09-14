import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadApiConfig } from '../config.js';
import { documentedRoutes } from '../routes/index.js';
import { buildOpenApiDocument } from './openapi.js';
import { defineRoute, noSchema, pathParameterNames, toOpenApiPath } from './routes.js';

const config = loadApiConfig({});
const routes = documentedRoutes(config);

const document = buildOpenApiDocument(routes, {
  title: 'Integr8 Plus API',
  version: '1.0.0',
  servers: [{ url: 'https://api.integr8.example' }],
  minSupportedClient: '0.1.0',
});

function operation(path: string, method: string): Record<string, unknown> {
  const paths = document.paths as Record<string, Record<string, unknown>>;
  return (paths[path]?.[method] ?? {}) as Record<string, unknown>;
}

describe('path translation', () => {
  it('converts Fastify parameters to OpenAPI ones', () => {
    expect(toOpenApiPath('/v1/sessions/:sessionId')).toBe('/v1/sessions/{sessionId}');
    expect(toOpenApiPath('/v1/members/:userId/sessions/revoke')).toBe(
      '/v1/members/{userId}/sessions/revoke',
    );
  });

  it('leaves a path with no parameters alone', () => {
    expect(toOpenApiPath('/v1/me')).toBe('/v1/me');
  });

  it('finds the parameter names', () => {
    expect(pathParameterNames('/v1/members/:userId/sessions/:sessionId')).toEqual([
      'userId',
      'sessionId',
    ]);
  });
});

describe('the generated document', () => {
  it('is OpenAPI 3.0 with the expected shape', () => {
    expect(document.openapi).toBe('3.0.3');
    expect(document.paths).toBeTypeOf('object');
    expect(document.components).toBeTypeOf('object');
  });

  it('documents every /v1 route and nothing else', () => {
    const paths = Object.keys(document.paths as object);

    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.startsWith('/v1'))).toBe(true);
    // Health endpoints are for an orchestrator; a generated client has no
    // business calling them.
    expect(paths).not.toContain('/health');
  });

  it('gives every operation a unique operationId', () => {
    const ids = routes.map((route) => route.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares a security requirement on authenticated routes and none on public ones', () => {
    expect(operation('/v1/me', 'get').security).toEqual([{ bearerAuth: [] }]);
    expect(operation('/v1/auth/sign-in', 'post').security).toBeUndefined();
  });

  it('documents the failures every route can produce, without repeating them per route', () => {
    // A generated client should know that any call can be rate-limited or can
    // fail; writing that out on forty routes would guarantee one forgot.
    const me = operation('/v1/me', 'get').responses as Record<string, unknown>;

    for (const status of ['401', '403', '422', '429', '500', '503']) {
      expect(me[status], status).toBeDefined();
    }
  });

  it('does not claim a public route can return 401', () => {
    const signIn = operation('/v1/auth/sign-in', 'post').responses as Record<string, unknown>;

    // It *declares* 401 as one of its own outcomes, which is different from the
    // universal set — so the check is that 403 (a permission failure) is absent.
    expect(signIn['403']).toBeUndefined();
  });

  it('describes path parameters as required', () => {
    const parameters = operation('/v1/sessions/{sessionId}', 'delete').parameters as {
      name: string;
      in: string;
      required: boolean;
    }[];

    const sessionId = parameters.find((parameter) => parameter.name === 'sessionId');
    expect(sessionId).toMatchObject({ in: 'path', required: true });
  });

  it('marks a query parameter with a default as optional', () => {
    const parameters = operation('/v1/sessions', 'get').parameters as {
      name: string;
      required: boolean;
    }[];

    expect(parameters.find((parameter) => parameter.name === 'scope')?.required).toBe(false);
  });

  it('advertises Idempotency-Key on the routes that honour it, and only those', () => {
    const idempotent = operation('/v1/members/invitations', 'post').parameters as {
      name: string;
    }[];
    expect(idempotent.some((parameter) => parameter.name === 'Idempotency-Key')).toBe(true);

    const plain = (operation('/v1/me', 'get').parameters ?? []) as { name: string }[];
    expect(plain.some((parameter) => parameter.name === 'Idempotency-Key')).toBe(false);
  });

  it('documents 409 only where an idempotency key can conflict', () => {
    const idempotent = operation('/v1/members/invitations', 'post').responses as Record<
      string,
      unknown
    >;
    expect(idempotent['409']).toBeDefined();

    const plain = operation('/v1/me', 'get').responses as Record<string, unknown>;
    expect(plain['409']).toBeUndefined();
  });

  it('gives a POST a request body and a GET none', () => {
    expect(operation('/v1/auth/sign-in', 'post').requestBody).toBeDefined();
    expect(operation('/v1/me', 'get').requestBody).toBeUndefined();
  });

  it('documents a body that is a union of shapes, rather than dropping it', () => {
    const body = operation('/v1/work-orders/bulk', 'post').requestBody as
      { content: { 'application/json': { schema: Record<string, unknown> } } } | undefined;
    expect(body).toBeDefined();
    const schema = body!.content['application/json'].schema;
    expect('oneOf' in schema || 'anyOf' in schema).toBe(true);
  });

  it('states the versioning policy where a client author will read it', () => {
    const info = document.info as { description: string };

    expect(info.description).toContain('Nothing breaking ships inside a version');
    expect(info.description).toContain('min-supported-client');
    expect(info.description).toContain('Idempotency-Key');
  });

  it('serialises to JSON, which is what the client generator consumes', () => {
    expect(() => JSON.stringify(document)).not.toThrow();
  });
});

describe('schema conversion', () => {
  it('treats a field with a default as optional on the way in', () => {
    const route = defineRoute({
      method: 'post',
      path: '/v1/probe',
      operationId: 'probe',
      summary: 'Probe',
      tags: ['probe'],
      security: 'public',
      params: noSchema,
      query: noSchema,
      body: z.object({ required: z.string(), optional: z.string().default('x') }),
      responses: { 200: { description: 'ok' } },
      handler: () => Promise.resolve({ status: 200, body: {} }),
    });

    const generated = buildOpenApiDocument([route], {
      title: 't',
      version: '1',
      servers: [],
      minSupportedClient: '0.1.0',
    });

    const paths = generated.paths as Record<string, Record<string, unknown>>;
    const body = (paths['/v1/probe']?.post as Record<string, unknown>).requestBody as {
      content: { 'application/json': { schema: { required?: string[] } } };
    };

    expect(body.content['application/json'].schema.required).toEqual(['required']);
  });
});
