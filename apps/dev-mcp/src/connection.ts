import { randomUUID } from 'node:crypto';
import type { Trace, TraceEntry } from './trace.js';

/**
 * Talking to one API as the signed-in staff account and, through audited
 * impersonation grants, as a test company's people (P38).
 *
 * Remote and local mode both end here: local mode is the same API booted on
 * this laptop and reached over 127.0.0.1. The staff session is refreshed when
 * its short access token lapses, and each rotated pair is handed to `persist`
 * at once, because a refresh token works only once. A grant's reason is the
 * only place the company's audit log records why the tool acted, so a grant
 * is reused only for calls with the same purpose: a new purpose ends that
 * person's grant and starts one stating it. Every grant still open is ended
 * when the server stops. Every request and answer goes to the trace, secrets hidden.
 */

export interface StaffTokens {
  accessToken: string;
  refreshToken: string;
  sessionExpiresAt: string;
}

export interface ApiAnswer {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  trace: TraceEntry;
}

export interface Person {
  /** `company`, or a member's user id. */
  key: string;
  label: string;
}

interface Grant {
  grantId: string;
  tenantId: string;
  accessToken: string;
  expiresAt: number;
  /** The purpose its reason states; a call with another purpose starts a new grant. */
  purpose: string;
}

export interface ConnectionOptions {
  api: string;
  tokens: StaffTokens;
  trace: Trace;
  clientVersion: string;
  /** Called with every rotated pair; the store keeps the newest. */
  persist?: (tokens: StaffTokens) => Promise<void>;
  fetch?: typeof fetch;
}

/** The reason every grant gives, so the company's audit log says plainly that the tool acted. */
export const REASON_PREFIX = 'Developer MCP:';

export class NotSignedInError extends Error {}

export class Connection {
  readonly api: string;
  #tokens: StaffTokens;
  readonly #trace: Trace;
  readonly #clientVersion: string;
  readonly #persist: ((tokens: StaffTokens) => Promise<void>) | undefined;
  readonly #fetch: typeof fetch;
  readonly #grants = new Map<string, Grant>();
  #refreshing: Promise<void> | undefined;

  constructor(options: ConnectionOptions) {
    this.api = options.api;
    this.#tokens = options.tokens;
    this.#trace = options.trace;
    this.#clientVersion = options.clientVersion;
    this.#persist = options.persist;
    this.#fetch = options.fetch ?? fetch;
  }

  get sessionExpiresAt(): Date {
    return new Date(this.#tokens.sessionExpiresAt);
  }

  /** One request, traced. `token` undefined sends none. */
  async request(input: {
    as: string;
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    rawBody?: { bytes: Uint8Array; contentType: string };
    token?: string;
    idempotencyKey?: string;
  }): Promise<ApiAnswer> {
    const query = Object.fromEntries(
      Object.entries(input.query ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
    );
    const search = new URLSearchParams(query).toString();
    const url = `${this.api}${input.path}${search === '' ? '' : `?${search}`}`;
    const headers: Record<string, string> = {
      'x-client-version': this.#clientVersion,
      // `api`: the value the API records for callers that are not one of its apps.
      'x-client-app': 'api',
      accept: 'application/json',
    };
    if (input.token !== undefined) {
      headers.authorization = `Bearer ${input.token}`;
    }
    if (input.idempotencyKey !== undefined) {
      headers['idempotency-key'] = input.idempotencyKey;
    }
    let payload: Blob | string | undefined;
    if (input.rawBody !== undefined) {
      headers['content-type'] = input.rawBody.contentType;
      payload = new Blob([new Uint8Array(input.rawBody.bytes)]);
    } else if (input.body !== undefined && input.method !== 'GET' && input.method !== 'DELETE') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(input.body);
    }
    const started = performance.now();
    let status = 0;
    let body: unknown = null;
    let responseHeaders: Record<string, string> = {};
    let error: string | undefined;
    try {
      const response = await this.#fetch(url, {
        method: input.method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
      status = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());
      const text = await response.text();
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const trace = this.#trace.record({
      as: input.as,
      method: input.method,
      path: input.path,
      query,
      requestHeaders: headers,
      requestBody:
        input.rawBody === undefined
          ? (input.body ?? null)
          : `(${String(input.rawBody.bytes.length)} bytes of ${input.rawBody.contentType})`,
      status,
      responseHeaders,
      responseBody: body,
      durationMs: Math.round(performance.now() - started),
      requestId: responseHeaders['x-request-id'] ?? null,
      ...(error === undefined ? {} : { error }),
    });
    if (error !== undefined) {
      throw new Error(`The API at ${this.api} could not be reached: ${error}`);
    }
    return { status, body, headers: responseHeaders, trace };
  }

  async #refresh(): Promise<void> {
    this.#refreshing ??= (async () => {
      const answer = await this.request({
        as: 'staff',
        method: 'POST',
        path: '/v1/platform/auth/refresh',
        body: { refreshToken: this.#tokens.refreshToken },
      });
      if (answer.status !== 200) {
        throw new NotSignedInError(
          'The staff session is over (it lasts 8 hours). Sign in again in a terminal: pnpm dev-mcp login',
        );
      }
      const tokens = answer.body as StaffTokens;
      this.#tokens = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionExpiresAt: tokens.sessionExpiresAt,
      };
      await this.#persist?.(this.#tokens);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /** A request as the signed-in staff account, refreshing once if its token lapsed. */
  async staff(input: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
  }): Promise<ApiAnswer> {
    if (this.sessionExpiresAt.getTime() <= Date.now()) {
      throw new NotSignedInError(
        'The staff session is over (it lasts 8 hours). Sign in again in a terminal: pnpm dev-mcp login',
      );
    }
    const first = await this.request({ ...input, as: 'staff', token: this.#tokens.accessToken });
    if (first.status !== 401) {
      return first;
    }
    await this.#refresh();
    return this.request({ ...input, as: 'staff', token: this.#tokens.accessToken });
  }

  /** The grant for one person of one company and one purpose, started when there is none, it lapsed or the purpose changed. */
  async #grantFor(tenantId: string, person: Person, purpose: string): Promise<Grant> {
    const key = `${tenantId}:${person.key}`;
    const stated = purpose.trim() === '' ? 'testing' : purpose.trim();
    const known = this.#grants.get(key);
    if (known?.purpose === stated && known.expiresAt - 30_000 > Date.now()) {
      return known;
    }
    if (known !== undefined) {
      this.#grants.delete(key);
      await this.#endGrant(known);
    }
    const reason = `${REASON_PREFIX} ${stated}`.slice(0, 500);
    const answer = await this.staff({
      method: 'POST',
      path: `/v1/platform/companies/${tenantId}/impersonate`,
      body: {
        reason: reason.length >= 10 ? reason : `${reason} (testing)`,
        ...(person.key === 'company' ? {} : { targetUserId: person.key }),
      },
    });
    if (answer.status !== 201) {
      throw new Error(
        `Could not act as ${person.label}: the API answered ${String(answer.status)} ${JSON.stringify(answer.trace.responseBody)}`,
      );
    }
    const started = answer.body as {
      grantId: string;
      expiresAt: string;
      tokens: { accessToken: string };
    };
    const grant: Grant = {
      grantId: started.grantId,
      tenantId,
      accessToken: started.tokens.accessToken,
      expiresAt: new Date(started.expiresAt).getTime(),
      purpose: stated,
    };
    this.#grants.set(key, grant);
    return grant;
  }

  /** Ends one grant; one already over or ended from the dashboard is no failure. */
  async #endGrant(grant: Grant): Promise<void> {
    await this.staff({
      method: 'POST',
      path: `/v1/platform/companies/${grant.tenantId}/impersonate/${grant.grantId}/end`,
    }).catch(() => undefined);
  }

  /** A request as one of a test company's people (or the company itself). */
  async as(input: {
    tenantId: string;
    person: Person;
    purpose: string;
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    rawBody?: { bytes: Uint8Array; contentType: string };
    idempotent?: boolean;
    idempotencyKey?: string;
  }): Promise<ApiAnswer> {
    const send = async (grant: Grant) =>
      this.request({
        as: input.person.label,
        method: input.method,
        path: input.path,
        ...(input.query === undefined ? {} : { query: input.query }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.rawBody === undefined ? {} : { rawBody: input.rawBody }),
        token: grant.accessToken,
        ...(input.idempotencyKey !== undefined
          ? { idempotencyKey: input.idempotencyKey }
          : input.idempotent === true
            ? { idempotencyKey: randomUUID() }
            : {}),
      });
    const grant = await this.#grantFor(input.tenantId, input.person, input.purpose);
    const answer = await send(grant);
    if (answer.status !== 401) {
      return answer;
    }
    // The grant lapsed or was ended from the dashboard: one fresh grant, then the answer stands.
    this.#grants.delete(`${input.tenantId}:${input.person.key}`);
    return send(await this.#grantFor(input.tenantId, input.person, input.purpose));
  }

  /** Ends every grant this server started. */
  async endGrants(): Promise<void> {
    const grants = [...this.#grants.values()];
    this.#grants.clear();
    await Promise.all(grants.map((grant) => this.#endGrant(grant)));
  }

  /** How many grants are open (status). */
  get openGrants(): number {
    return this.#grants.size;
  }
}
