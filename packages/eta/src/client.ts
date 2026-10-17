/**
 * The ETA's HTTP API, for one company's credentials in one environment.
 *
 * Provided (README "Auth/API"): the token endpoint and its form, submission,
 * and the document-type version endpoint that returns the JSON Schema.
 * SPEC-UNVERIFIED(status-api, submit-response, intermediary): the status,
 * submission, PDF and cancel endpoints, the shape of their answers and the
 * intermediary header are recalled from the SDK and must be checked on the
 * first PreProd run. Every answer is read defensively for that reason.
 *
 * Nothing here retries a submission: a submission whose answer is lost is
 * reconciled by a person (PLAN §3). Reads are retried a little, honouring
 * `Retry-After`.
 */

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export type EtaTransport = (request: TransportRequest) => Promise<TransportResponse>;

/** Thrown by a transport when no answer came back in time, or the connection broke. */
export class TransportError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export type EtaErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unexpected';

export interface EtaErrorDetail {
  code: string | null;
  message: string;
  target: string | null;
}

export class EtaApiError extends Error {
  constructor(
    readonly operation: string,
    readonly kind: EtaErrorKind,
    readonly status: number | null,
    readonly code: string | null,
    readonly details: EtaErrorDetail[],
    readonly retryAfterMs: number | null,
    readonly correlationId: string,
    message: string,
  ) {
    super(message);
    this.name = 'EtaApiError';
  }

  /** Whether the request may have reached the ETA and been acted on. */
  get ambiguous(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'server';
  }
}

export interface EtaEndpoints {
  identityBaseUrl: string;
  apiBaseUrl: string;
}

export interface EtaCredentials {
  clientId: string;
  clientSecret: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Tokens by key (company, environment, credential version), in memory, one
 * request at a time per key. Never shared between keys, never persisted.
 */
export class EtaTokenCache {
  readonly #tokens = new Map<string, CachedToken>();
  readonly #pending = new Map<string, Promise<CachedToken>>();

  constructor(private readonly skewMs = 60_000) {}

  async get(key: string, now: () => number, fetch: () => Promise<CachedToken>): Promise<string> {
    const cached = this.#tokens.get(key);
    if (cached !== undefined && cached.expiresAt - this.skewMs > now()) {
      return cached.token;
    }
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = fetch().finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    const fresh = await pending;
    this.#tokens.set(key, fresh);
    return fresh.token;
  }

  invalidate(key: string): void {
    this.#tokens.delete(key);
  }

  /** Forgets every token whose key starts with this prefix: a company whose credentials changed. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.#tokens.keys()) {
      if (key.startsWith(prefix)) {
        this.#tokens.delete(key);
      }
    }
  }
}

export interface EtaClientOptions {
  endpoints: EtaEndpoints;
  credentials: EtaCredentials;
  /** Unique per company, environment and credential version. */
  cacheKey: string;
  cache: EtaTokenCache;
  transport: EtaTransport;
  /** Only for an intermediary login: the taxpayer acted for. SPEC-UNVERIFIED(intermediary). */
  onBehalfOf?: string | null;
  scope?: string | null;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newCorrelationId?: () => string;
}

export interface SubmissionResult {
  submissionId: string | null;
  accepted: { uuid: string; longId: string | null; internalId: string | null }[];
  rejected: { internalId: string | null; error: EtaErrorDetail & { details: EtaErrorDetail[] } }[];
  correlationId: string;
}

export interface DocumentStatus {
  uuid: string;
  /** As the ETA spells it: `Valid`, `Invalid`, `Submitted`, `Cancelled`, `Rejected`. */
  status: string | null;
  longId: string | null;
  validationErrors: EtaErrorDetail[];
  correlationId: string;
}

export interface DocumentTypeVersion {
  documentTypeId: string;
  versionId: string;
  versionNumber: string | null;
  status: string | null;
  /** The decoded JSON Schema text. */
  schemaText: string;
  correlationId: string;
}

const READ_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 30_000;

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function readJson(bytes: Uint8Array): unknown {
  const text = decodeText(bytes).trim();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== ''
    ? value
    : typeof value === 'number'
      ? String(value)
      : null;
}

/** Finds a property whatever its casing: the ETA's answers mix camel and Pascal case. */
function field(value: Json | null, name: string): unknown {
  if (value === null) {
    return undefined;
  }
  const key = Object.keys(value).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key === undefined ? undefined : value[key];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function errorDetail(value: unknown): EtaErrorDetail {
  const entry = record(value);
  return {
    code: textOf(field(entry, 'code')),
    message: textOf(field(entry, 'message')) ?? textOf(field(entry, 'error')) ?? 'Unknown error',
    target: textOf(field(entry, 'target')) ?? textOf(field(entry, 'propertyPath')),
  };
}

function kindFor(status: number): EtaErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unexpected';
}

function retryAfter(headers: Record<string, string>, now: number): number | null {
  const value = headers['retry-after'];
  if (value === undefined) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

const trimSlash = (url: string) => url.replace(/\/+$/u, '');

export class EtaClient {
  readonly #options: Required<Omit<EtaClientOptions, 'onBehalfOf' | 'scope'>> & {
    onBehalfOf: string | null;
    scope: string | null;
  };

  constructor(options: EtaClientOptions) {
    this.#options = {
      timeoutMs: 30_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      newCorrelationId: () => globalThis.crypto.randomUUID(),
      ...options,
      onBehalfOf: options.onBehalfOf ?? null,
      scope: options.scope ?? null,
    };
  }

  #api(path: string): string {
    return `${trimSlash(this.#options.endpoints.apiBaseUrl)}${path}`;
  }

  async #send(
    operation: string,
    request: Omit<TransportRequest, 'timeoutMs'>,
    correlationId: string,
  ): Promise<TransportResponse> {
    try {
      return await this.#options.transport({ ...request, timeoutMs: this.#options.timeoutMs });
    } catch (error) {
      const kind = error instanceof TransportError ? error.kind : 'network';
      throw new EtaApiError(
        operation,
        kind,
        null,
        null,
        [],
        null,
        correlationId,
        kind === 'timeout'
          ? 'The tax authority did not answer in time.'
          : 'The tax authority could not be reached.',
      );
    }
  }

  #fail(operation: string, response: TransportResponse, correlationId: string): EtaApiError {
    const body = record(readJson(response.body));
    const error = record(field(body, 'error'));
    const detail = error === null ? errorDetail(body) : errorDetail(error);
    const details = list(field(error, 'details')).map(errorDetail);
    return new EtaApiError(
      operation,
      kindFor(response.status),
      response.status,
      detail.code ?? textOf(field(body, 'error')),
      details,
      retryAfter(response.headers, this.#options.now()),
      correlationId,
      detail.message,
    );
  }

  async #token(): Promise<string> {
    const { endpoints, credentials, cache, cacheKey, now } = this.#options;
    return cache.get(cacheKey, now, async () => {
      const correlationId = this.#options.newCorrelationId();
      const form = new URLSearchParams({ grant_type: 'client_credentials' });
      if (this.#options.scope !== null) {
        form.set('scope', this.#options.scope);
      }
      const headers: Record<string, string> = {
        authorization: `Basic ${base64(`${credentials.clientId}:${credentials.clientSecret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'x-correlation-id': correlationId,
      };
      if (this.#options.onBehalfOf !== null) {
        headers.onbehalfof = this.#options.onBehalfOf;
      }
      const response = await this.#send(
        'token',
        {
          method: 'POST',
          url: `${trimSlash(endpoints.identityBaseUrl)}/connect/token`,
          headers,
          body: form.toString(),
        },
        correlationId,
      );
      if (response.status !== 200) {
        throw this.#fail('token', response, correlationId);
      }
      const body = record(readJson(response.body));
      const token = textOf(field(body, 'access_token'));
      const expiresIn = Number(field(body, 'expires_in'));
      if (token === null || !Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new EtaApiError(
          'token',
          'unexpected',
          response.status,
          null,
          [],
          null,
          correlationId,
          'The token answer was not understood.',
        );
      }
      return { token, expiresAt: now() + expiresIn * 1000 };
    });
  }

  /** One authenticated request; a 401 refreshes the token once; reads retry a little. */
  async #call(
    operation: string,
    request: { method: TransportRequest['method']; path: string; body?: string; accept?: string },
    options: { retry: boolean },
  ): Promise<{ response: TransportResponse; correlationId: string }> {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const correlationId = this.#options.newCorrelationId();
      const token = await this.#token();
      const response = await this.#send(
        operation,
        {
          method: request.method,
          url: this.#api(request.path),
          headers: {
            authorization: `Bearer ${token}`,
            accept: request.accept ?? 'application/json',
            'x-correlation-id': correlationId,
            ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
        },
        correlationId,
      ).catch(async (error: unknown) => {
        if (options.retry && error instanceof EtaApiError && attempt < READ_RETRIES) {
          await this.#options.sleep(1000 * 2 ** attempt);
          return null;
        }
        throw error;
      });
      if (response === null) {
        continue;
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.#options.cache.invalidate(this.#options.cacheKey);
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        return { response, correlationId };
      }
      const failure = this.#fail(operation, response, correlationId);
      if (
        options.retry &&
        (failure.kind === 'rate_limited' || failure.kind === 'server') &&
        attempt < READ_RETRIES
      ) {
        await this.#options.sleep(
          Math.min(failure.retryAfterMs ?? 1000 * 2 ** attempt, MAX_RETRY_WAIT_MS),
        );
        continue;
      }
      throw failure;
    }
  }

  /** Checks the credentials by asking for a token. */
  async checkCredentials(): Promise<void> {
    this.#options.cache.invalidate(this.#options.cacheKey);
    await this.#token();
  }

  /**
   * Submits signed documents, each exactly as its JSON text: the text is
   * placed in the body unchanged, so what was signed is what is sent.
   */
  async submit(signedDocuments: readonly string[]): Promise<SubmissionResult> {
    const body = `{"documents":[${signedDocuments.join(',')}]}`;
    const { response, correlationId } = await this.#call(
      'submit',
      { method: 'POST', path: '/api/v1.0/documentsubmissions/', body },
      { retry: false },
    );
    const answer = record(readJson(response.body));
    return {
      submissionId: textOf(field(answer, 'submissionId')),
      accepted: list(field(answer, 'acceptedDocuments')).map((entry) => {
        const value = record(entry);
        return {
          uuid: textOf(field(value, 'uuid')) ?? '',
          longId: textOf(field(value, 'longId')),
          internalId: textOf(field(value, 'internalId')),
        };
      }),
      rejected: list(field(answer, 'rejectedDocuments')).map((entry) => {
        const value = record(entry);
        const error = record(field(value, 'error'));
        return {
          internalId: textOf(field(value, 'internalId')),
          error: { ...errorDetail(error), details: list(field(error, 'details')).map(errorDetail) },
        };
      }),
      correlationId,
    };
  }

  /** A document's status and validation results. */
  async documentStatus(uuid: string): Promise<DocumentStatus> {
    const { response, correlationId } = await this.#call(
      'status',
      { method: 'GET', path: `/api/v1.0/documents/${encodeURIComponent(uuid)}/details` },
      { retry: true },
    );
    const answer = record(readJson(response.body));
    const validation = record(field(answer, 'validationResults'));
    const errors: EtaErrorDetail[] = [];
    for (const step of list(field(validation, 'validationSteps'))) {
      const entry = record(step);
      const status = textOf(field(entry, 'status'));
      const error = record(field(entry, 'error'));
      if (status !== null && status.toLowerCase() === 'invalid' && error !== null) {
        errors.push(errorDetail(error));
        for (const inner of list(field(error, 'innerError'))) {
          errors.push(errorDetail(inner));
        }
      }
    }
    return {
      uuid,
      status: textOf(field(answer, 'status')),
      longId: textOf(field(answer, 'longId')),
      validationErrors: errors,
      correlationId,
    };
  }

  /** The ETA's printable copy. */
  async documentPdf(uuid: string): Promise<Uint8Array> {
    const { response } = await this.#call(
      'pdf',
      {
        method: 'GET',
        path: `/api/v1.0/documents/${encodeURIComponent(uuid)}/pdf`,
        accept: 'application/pdf',
      },
      { retry: true },
    );
    return response.body;
  }

  /** Asks the ETA to cancel a valid document. Not retried. */
  async cancel(uuid: string, reason: string): Promise<{ correlationId: string }> {
    const { correlationId } = await this.#call(
      'cancel',
      {
        method: 'PUT',
        path: `/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`,
        body: JSON.stringify({ status: 'cancelled', reason }),
      },
      { retry: false },
    );
    return { correlationId };
  }

  /** Document types and their versions, as the ETA lists them. */
  async documentTypes(): Promise<
    {
      id: string;
      name: string | null;
      versions: { id: string; number: string | null; status: string | null }[];
    }[]
  > {
    const { response } = await this.#call(
      'document_types',
      { method: 'GET', path: '/api/v1.0/documenttypes' },
      { retry: true },
    );
    const answer = readJson(response.body);
    const items = Array.isArray(answer) ? answer : list(field(record(answer), 'result'));
    return items.map((entry) => {
      const value = record(entry);
      return {
        id: textOf(field(value, 'id')) ?? '',
        name: textOf(field(value, 'name')),
        versions: list(field(value, 'documentTypeVersions')).map((version) => {
          const v = record(version);
          return {
            id: textOf(field(v, 'id')) ?? '',
            number: textOf(field(v, 'versionNumber')) ?? textOf(field(v, 'name')),
            status: textOf(field(v, 'status')),
          };
        }),
      };
    });
  }

  /** One version's JSON Schema, decoded from Base64. */
  async documentTypeVersion(
    documentTypeId: string,
    versionId: string,
  ): Promise<DocumentTypeVersion> {
    const { response, correlationId } = await this.#call(
      'document_type_version',
      {
        method: 'GET',
        path: `/api/v1.0/documenttypes/${encodeURIComponent(documentTypeId)}/versions/${encodeURIComponent(versionId)}`,
      },
      { retry: true },
    );
    const answer = record(readJson(response.body));
    const encoded = textOf(field(answer, 'jsonSchema'));
    if (encoded === null) {
      throw new EtaApiError(
        'document_type_version',
        'unexpected',
        response.status,
        null,
        [],
        null,
        correlationId,
        'The answer had no JSON Schema.',
      );
    }
    const binary = atob(encoded.replace(/\s+/gu, ''));
    const schemaText = new TextDecoder('utf-8')
      .decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
      .replace(/^\uFEFF/u, '');
    return {
      documentTypeId,
      versionId,
      versionNumber: textOf(field(answer, 'versionNumber')) ?? textOf(field(answer, 'name')),
      status: textOf(field(answer, 'status')),
      schemaText,
      correlationId,
    };
  }
}
