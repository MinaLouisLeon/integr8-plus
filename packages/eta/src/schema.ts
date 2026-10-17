import { Ajv, type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

/**
 * Validation against the ETA's own JSON Schema for a document type version,
 * as `GET /api/v1.0/documenttypes/{id}/versions/{vid}` returns it (Base64 in
 * `jsonSchema`; README "Auth/API"). The schema is fetched with each company's
 * credentials and kept per company and environment; nothing here ships one.
 *
 * The validator reads a parsed copy of the document. That copy holds numbers
 * as JavaScript numbers, which is fine for type and presence checks; a
 * `multipleOf` is compared with tolerance (`multipleOfPrecision`). The text
 * that is signed and sent is never this copy.
 */

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv;

export interface SchemaIssue {
  path: string;
  message: string;
  keyword: string;
}

export class SchemaUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaUnreadableError';
  }
}

/** Decodes a Base64 `jsonSchema` value into its JSON text. */
export function decodeSchemaBase64(value: string): string {
  const binary = atob(value.replace(/\s+/gu, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/u, '');
}

function ajvFor(schema: Record<string, unknown>): Ajv {
  const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
  const options = { allErrors: true, strict: false, multipleOfPrecision: 6 } as const;
  const ajv = dialect.includes('2020-12')
    ? new Ajv2020(options)
    : dialect.includes('2019-09')
      ? new Ajv2019(options)
      : new Ajv(options);
  addFormats(ajv);
  return ajv;
}

export interface CompiledSchema {
  validate(documentJson: string): SchemaIssue[];
}

/** Compiles a schema's JSON text, or throws `SchemaUnreadableError`. */
export function compileSchema(schemaText: string): CompiledSchema {
  let schema: unknown;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    throw new SchemaUnreadableError('The schema is not JSON');
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new SchemaUnreadableError('The schema is not an object');
  }
  let validate: ValidateFunction;
  try {
    validate = ajvFor(schema as Record<string, unknown>).compile(schema as AnySchema);
  } catch (error) {
    throw new SchemaUnreadableError(
      `The schema does not compile: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  return {
    validate(documentJson: string): SchemaIssue[] {
      const parsed: unknown = JSON.parse(documentJson);
      if (validate(parsed)) {
        return [];
      }
      return (validate.errors ?? []).map((error: ErrorObject) => ({
        path: error.instancePath === '' ? '/' : error.instancePath,
        message: error.message ?? error.keyword,
        keyword: error.keyword,
      }));
    },
  };
}
