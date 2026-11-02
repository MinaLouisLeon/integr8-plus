import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEBSITE_ENDPOINTS, WEBSITE_KEY_PATTERN } from './contract.js';

/**
 * The website contract is written by hand (this program cannot import the
 * API), so it is held to the API's generated OpenAPI document: a field, a
 * required flag or a refusal status that changes there fails here.
 */

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  nullable?: boolean;
}

interface Operation {
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, { schema: Schema }> }>;
  security?: Record<string, unknown>[];
}

const openapi = JSON.parse(
  readFileSync(new URL('../../../api/openapi.json', import.meta.url), 'utf8'),
) as { paths: Record<string, Record<string, Operation>> };

/** Statuses every route answers; the contract describes only the route's own. */
const GENERIC = new Set(['200', '500', '503']);

describe('the website contract', () => {
  for (const endpoint of WEBSITE_ENDPOINTS) {
    describe(`${endpoint.method} ${endpoint.path}`, () => {
      const operation = openapi.paths[endpoint.path]?.[endpoint.method.toLowerCase()];

      it('exists in openapi.json with the website key', () => {
        expect(operation).toBeDefined();
        expect(operation!.security).toEqual([{ websiteKeyAuth: [] }]);
      });

      it('has the same path parameters', () => {
        const params = (operation!.parameters ?? []).filter((param) => param.in === 'path');
        expect(params.map((param) => param.name).sort()).toEqual(
          endpoint.pathParams.map((field) => field.name).sort(),
        );
      });

      it('has the same body fields', () => {
        const schema = operation!.requestBody?.content['application/json']?.schema;
        expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
          endpoint.body.map((field) => field.name).sort(),
        );
        const required = new Set(schema?.required ?? []);
        for (const field of endpoint.body) {
          expect(required.has(field.name), field.name).toBe(field.required);
        }
      });

      it('has the same answer fields', () => {
        const schema = operation!.responses['200']!.content!['application/json']!.schema;
        expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
          endpoint.response.map((field) => field.name).sort(),
        );
        expect([...(schema.required ?? [])].sort()).toEqual(
          endpoint.response
            .filter((field) => field.required)
            .map((field) => field.name)
            .sort(),
        );
        if (endpoint.documentFields.length > 0) {
          const document = schema.properties!.document!;
          expect(document.nullable).toBe(true);
          expect(Object.keys(document.properties ?? {}).sort()).toEqual(
            endpoint.documentFields.map((field) => field.name).sort(),
          );
          expect([...(document.required ?? [])].sort()).toEqual(
            endpoint.documentFields
              .filter((field) => field.required)
              .map((field) => field.name)
              .sort(),
          );
        }
      });

      it('lists the same refusals', () => {
        const statuses = Object.keys(operation!.responses).filter((status) => !GENERIC.has(status));
        expect(statuses.sort()).toEqual(
          [...new Set(endpoint.errors.map((error) => String(error.status)))].sort(),
        );
      });
    });
  }

  it('knows the website key format', () => {
    expect(WEBSITE_KEY_PATTERN.test(`i8wk_${'a'.repeat(43)}`)).toBe(true);
    expect(WEBSITE_KEY_PATTERN.test(`i8wk_${'a'.repeat(42)}`)).toBe(false);
  });
});
