import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  conflict,
  errorResponseSchema,
  isClientError,
  notFound,
  tooManyRequests,
  unauthorised,
  validationError,
} from './errors.js';

const REQUEST_ID = '018f2b3c-4d5e-7f80-9a1b-2c3d4e5f6071';

describe('the response shape', () => {
  it('always carries a code, a message and the request id', () => {
    const body = notFound('No such thing').toResponse(REQUEST_ID);

    expect(errorResponseSchema.parse(body)).toEqual({
      error: { code: 'not_found', message: 'No such thing', requestId: REQUEST_ID },
    });
  });

  it('omits details entirely rather than sending an empty array', () => {
    const body = new ApiError(400, 'bad', 'Bad', []).toResponse(REQUEST_ID);
    expect('details' in body.error).toBe(false);
  });

  it('includes details when there are any', () => {
    const body = new ApiError(422, 'invalid', 'Invalid', [
      { field: 'body.email', code: 'invalid_format', message: 'Not an email address' },
    ]).toResponse(REQUEST_ID);

    expect(body.error.details).toEqual([
      { field: 'body.email', code: 'invalid_format', message: 'Not an email address' },
    ]);
  });

  it('parses as the schema the OpenAPI document publishes', () => {
    for (const error of [
      notFound(),
      unauthorised(),
      conflict('idempotency_key_reused', 'Reused'),
      tooManyRequests('Slow down', 30),
    ]) {
      expect(errorResponseSchema.safeParse(error.toResponse(REQUEST_ID)).success).toBe(true);
    }
  });
});

describe('validation details', () => {
  const schema = z.object({
    email: z.string().min(3),
    profile: z.object({ age: z.number().int() }),
  });

  it('names the part of the request each problem is in', () => {
    const result = schema.safeParse({ email: 'a', profile: { age: 1.5 } });
    expect(result.success).toBe(false);

    const error = validationError('body', result.error!);
    const fields = error.details?.map((detail) => detail.field) ?? [];

    // Prefixed, so a client can map a detail back to an input without guessing
    // whether `age` came from the body or the query.
    expect(fields).toContain('body.email');
    expect(fields).toContain('body.profile.age');
  });

  it('reports every problem at once', () => {
    const result = schema.safeParse({ email: 'a', profile: { age: 1.5 } });
    const error = validationError('body', result.error!);

    expect(error.details?.length).toBe(2);
    expect(error.status).toBe(422);
    expect(error.code).toBe('validation_failed');
  });

  it('distinguishes query from body', () => {
    const result = z.object({ limit: z.number() }).safeParse({ limit: 'ten' });
    const error = validationError('query', result.error!);

    expect(error.details?.[0]?.field).toBe('query.limit');
  });
});

describe('what each helper says', () => {
  it('gives the same 401 whatever went wrong', () => {
    // Missing header, wrong scheme, malformed token, expired token, revoked
    // session: telling a caller which one it was tells an attacker how close
    // they are.
    expect(unauthorised().message).toBe('Authentication is required');
    expect(unauthorised().status).toBe(401);
  });

  it('attaches Retry-After to a rate-limit rejection', () => {
    const error = tooManyRequests('Slow down', 12.3);
    expect(error.headers?.['retry-after']).toBe('13');
  });

  it('never sends a Retry-After of zero', () => {
    // A client reading `Retry-After: 0` retries immediately, which is the
    // opposite of what a rate limiter is asking for.
    expect(tooManyRequests('Slow down', 0).headers?.['retry-after']).toBe('1');
    expect(tooManyRequests('Slow down', -5).headers?.['retry-after']).toBe('1');
  });
});

describe('classification', () => {
  it('treats 4xx as the caller’s problem and 5xx as ours', () => {
    expect(isClientError(notFound())).toBe(true);
    expect(isClientError(new ApiError(422, 'invalid', 'Invalid'))).toBe(true);
    expect(isClientError(new ApiError(500, 'internal_error', 'Oops'))).toBe(false);
    expect(isClientError(new ApiError(503, 'client_too_old', 'Update'))).toBe(false);
    expect(isClientError(new Error('something else'))).toBe(false);
  });
});
