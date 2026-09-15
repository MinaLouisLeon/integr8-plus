import createOpenApiClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

/**
 * The generated API client.
 *
 * Types come from `openapi.json`, which is generated from the route registry in
 * `apps/api`. Nothing here is hand-maintained: if an endpoint changes shape and
 * a caller is not updated, the caller stops compiling. That is the whole point
 * of the contract — a signed desktop binary and an App Store build cannot be
 * force-updated, so a mismatch has to be caught at build time or it is caught
 * by a customer.
 *
 * The runtime is a thin wrapper over `fetch`: no bespoke request code is
 * generated, so a spec change produces a readable diff in the types and nothing
 * else, and the same client works unchanged in React Native.
 *
 * What this does **not** do is manage tokens. It asks for one and reports when
 * the server rejects it; where the token lives and how it is refreshed is a
 * per-client decision, and P05 wires it to the OS keychain, SecureStore or an
 * httpOnly cookie.
 */

export type { paths } from './generated/schema.js';

export interface ClientOptions {
  /** e.g. `https://api.integr8.example`. No trailing slash required. */
  baseUrl: string;

  /**
   * Which app this is, and which build.
   *
   * Sent on every request so the server can say "this build is too old" once,
   * clearly, instead of letting it fail confusingly on some later call.
   */
  clientApp: 'web' | 'desktop' | 'mobile';
  clientVersion: string;

  /** Returns the current access token, or null when signed out. */
  getAccessToken: () => string | null | Promise<string | null>;

  /**
   * Called when the server rejects the access token.
   *
   * Returns a fresh token to retry with, or null to give up. This is the seam
   * P05 fills with a refresh that de-duplicates concurrent 401s, so twenty
   * parallel requests produce one refresh rather than twenty.
   */
  onUnauthorised?: () => Promise<string | null>;

  /** Called when this build is older than the server's minimum. */
  onClientTooOld?: (info: { minimum: string; message: string }) => void;

  /** Injectable for tests and for React Native's fetch. */
  fetch?: typeof globalThis.fetch;
}

/** One thing wrong with a request: which field, what, and the values that say more. */
export interface ApiErrorDetail {
  field: string;
  code: string;
  message: string;
  params?: Record<string, string>;
}

/** The error model every failure uses. Mirrors `errorResponseSchema` in the API. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
    requestId: string;
  };
}

/**
 * A failed request, with the request id attached.
 *
 * The id is the same one on every server log line for this request, so
 * including it in a bug report turns "it didn't work" into something
 * answerable. Clients should show it on their error screens.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly details: ApiErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** True for the failures a caller can fix by changing the request. */
  get isValidation(): boolean {
    return this.status === 422;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /** True when this build is older than the server's minimum supported client. */
  get isClientTooOld(): boolean {
    return this.code === 'client_too_old';
  }
}

export type Integr8Client = ReturnType<typeof createClient>;

export function createClient(options: ClientOptions) {
  const client = createOpenApiClient<paths>({
    baseUrl: options.baseUrl.replace(/\/+$/u, ''),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  client.use(identityMiddleware(options));
  client.use(errorMiddleware(options));

  return client;
}

/** Adds the auth header and the two client-identity headers to every request. */
function identityMiddleware(options: ClientOptions): Middleware {
  return {
    async onRequest({ request }) {
      request.headers.set('x-client-app', options.clientApp);
      request.headers.set('x-client-version', options.clientVersion);

      const token = await options.getAccessToken();
      if (token !== null && token !== '') {
        request.headers.set('authorization', `Bearer ${token}`);
      }

      return request;
    },
  };
}

/**
 * Turns a failure response into a thrown {@link ApiRequestError}, and retries
 * once after refreshing an expired token.
 *
 * One retry, not a loop: if a freshly refreshed token is also rejected, the
 * problem is not the token, and retrying would turn one failure into a storm
 * against a server that has already said no twice.
 */
function errorMiddleware(options: ClientOptions): Middleware {
  return {
    async onResponse({ request, response }) {
      if (response.ok) {
        return response;
      }

      await announceIfTooOld(response, options);

      if (response.status === 401 && options.onUnauthorised !== undefined) {
        const refreshed = await options.onUnauthorised();

        if (refreshed !== null && refreshed !== '') {
          const retry = new Request(request);
          retry.headers.set('authorization', `Bearer ${refreshed}`);
          const retried = await (options.fetch ?? globalThis.fetch)(retry);

          if (retried.ok) {
            return retried;
          }

          // The retry is not passed back through this middleware, so its
          // failure has to be converted here or the caller would receive
          // openapi-fetch's raw result instead of a thrown error — a different
          // shape for the same problem, depending on whether a refresh
          // happened to be attempted.
          await announceIfTooOld(retried, options);
          throw await toRequestError(retried);
        }
      }

      throw await toRequestError(response);
    },
  };
}

/** Builds the thrown error from a failure response. */
async function toRequestError(response: Response): Promise<ApiRequestError> {
  const body = await readErrorBody(response);

  return new ApiRequestError(
    response.status,
    body?.error.code ?? 'unknown_error',
    body?.error.message ?? `The request failed with status ${String(response.status)}.`,
    body?.error.requestId ?? response.headers.get('x-request-id') ?? '',
    body?.error.details ?? [],
  );
}

/**
 * Tells the app when this build is older than the server's minimum.
 *
 * Separate from the thrown error because it is a different audience: the error
 * goes to the call site, this goes to whatever shows the user a "please update"
 * screen, and that screen should appear whichever call happened to discover it.
 */
async function announceIfTooOld(response: Response, options: ClientOptions): Promise<void> {
  if (options.onClientTooOld === undefined) {
    return;
  }

  const body = await readErrorBody(response);
  if (body?.error.code === 'client_too_old') {
    options.onClientTooOld({
      minimum: response.headers.get('min-supported-client') ?? '',
      message: body.error.message,
    });
  }
}

async function readErrorBody(response: Response): Promise<ApiErrorBody | undefined> {
  try {
    const parsed: unknown = await response.clone().json();
    return isApiErrorBody(parsed) ? parsed : undefined;
  } catch {
    // A proxy or a load balancer can produce an HTML error page. Falling back
    // to the status is better than failing while reporting a failure.
    return undefined;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const error = (value as { error?: unknown }).error;
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

export {
  SessionManager,
  type Membership,
  type SessionManagerOptions,
  type SignInInput,
  type SignInResult,
  type SignOutReason,
} from './session.js';
