import { z } from 'zod';

/**
 * The error model, and the only shape this API returns when something fails.
 *
 * Four parts, each with a distinct audience:
 *
 * - `code` — for the client's code. Stable, machine-readable, and part of the
 *   contract: it may gain values inside a version but never change meaning.
 * - `message` — for a person. Never the place to put anything a caller has to
 *   parse, and never anything an unauthenticated stranger should not read.
 * - `details` — field-level, so a form can highlight the offending input
 *   instead of showing one message above everything.
 * - `requestId` — the same id that appears on every log line for this request.
 *   It is what turns "it didn't work" into something answerable.
 *
 * A uniform shape matters more than it looks. Four clients, one of them a
 * signed binary six months old, all have to render failures; a surface where
 * some errors are `{message}` and others `{error: "..."}` produces four
 * different half-correct error screens.
 */

export const errorDetailSchema = z.object({
  /** Dotted path into the request, e.g. `body.email` or `query.limit`. */
  field: z.string(),
  code: z.string(),
  message: z.string(),
  /**
   * Values the message was built from, for a client that shows its own
   * translated text for `code`: `{ minimum: "3" }` for `too_short`.
   */
  params: z.record(z.string(), z.string()).optional(),
});

export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/**
 * An error with an HTTP status and a stable code.
 *
 * Everything thrown deliberately by a handler is one of these. Anything else
 * that escapes becomes a 500 with no detail, because an unexpected exception's
 * message is written for us and not for a stranger.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly ErrorDetail[],
    /** Extra headers this failure requires, such as `Retry-After`. */
    readonly headers?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toResponse(requestId: string): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined || this.details.length === 0
          ? {}
          : { details: [...this.details] }),
        requestId,
      },
    };
  }
}

export const badRequest = (code: string, message: string, details?: readonly ErrorDetail[]) =>
  new ApiError(400, code, message, details);

/**
 * Authentication failed or was absent.
 *
 * The message is deliberately the same whether a token was missing, malformed,
 * expired, or names a session that has been revoked. Distinguishing them tells
 * an attacker which of those they achieved.
 */
export const unauthorised = (message = 'Authentication is required') =>
  new ApiError(401, 'unauthorised', message);

export const forbidden = (message: string, details?: readonly ErrorDetail[]) =>
  new ApiError(403, 'forbidden', message, details);

export const notFound = (message = 'Not found') => new ApiError(404, 'not_found', message);

export const conflict = (code: string, message: string) => new ApiError(409, code, message);

export const unprocessable = (code: string, message: string, details?: readonly ErrorDetail[]) =>
  new ApiError(422, code, message, details);

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new ApiError(429, 'rate_limited', message, undefined, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

export const internal = (message = 'Something went wrong on our side') =>
  new ApiError(500, 'internal_error', message);

/**
 * Turns a zod failure into field-level details.
 *
 * `issue.path` is where in the request the problem is, and prefixing it with
 * the part being validated is what lets a client map a detail back to an input
 * without guessing whether `limit` came from the query or the body.
 */
export function validationError(where: 'body' | 'query' | 'params' | 'headers', error: z.ZodError) {
  const details: ErrorDetail[] = error.issues.map((issue) => ({
    field: [where, ...issue.path.map(String)].join('.'),
    code: issue.code,
    message: issue.message,
  }));

  return new ApiError(422, 'validation_failed', `The request ${where} is not valid.`, details);
}

/** True for the errors a client caused, which are logged at a lower level. */
export function isClientError(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500;
}
