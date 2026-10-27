import type { Role } from '@integr8/core';
import type { FastifyInstance } from 'fastify';
import { randomInt, randomUUID } from 'node:crypto';

/**
 * What every section of the demo seed works with.
 *
 * The seed fills the company by calling the API itself, in-process, as the
 * company's own people. Nothing is inserted behind the API's back, so every
 * row the seed makes is a row the app could have made: the same validation,
 * the same numbering, the same stock movements and ledger postings, the same
 * audit lines. A seed that wrote tables directly would happily create data
 * the screens can never show.
 */

/** Who a request is made as. `staff` is Integr8 staff acting as the company. */
export type Actor =
  | 'owner'
  | 'admin'
  | 'hr'
  | 'store'
  | 'dispatcher'
  | 'engineer1'
  | 'engineer2'
  | 'engineer3'
  | 'viewer'
  | 'staff';

export interface DemoPerson {
  key: Exclude<Actor, 'staff'>;
  userId: string;
  email: string;
  displayName: string;
  role: Role;
}

export class DemoRequestError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${url} answered ${String(status)}: ${body.slice(0, 600)}`);
  }
}

type Body = Record<string, unknown> | unknown[] | undefined;

export interface DemoContext {
  readonly tenantId: string;
  readonly people: Readonly<Record<Exclude<Actor, 'staff'>, DemoPerson>>;
  /** Shared ids, filled as sections run, read by later ones. */
  readonly refs: DemoRefs;
  // The seed reads a field or two from each answer; typing every response in
  // full would be the OpenAPI document again. Callers name a type when they
  // keep one.
  /** Sends a request and returns the parsed body; throws on anything but 2xx. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call: <T = any>(as: Actor, method: string, url: string, body?: Body) => Promise<T>;
  /** Like {@link call}, but returns undefined instead of throwing on a 4xx. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attempt: <T = any>(as: Actor, method: string, url: string, body?: Body) => Promise<T | undefined>;
  /** Progress line, indented under the section heading. */
  log: (message: string) => void;
  /** Something that did not go in. The seed keeps going and reports these at the end. */
  warn: (message: string) => void;
  readonly warnings: string[];
}

/** A loose bag of ids that later sections look up. Each section documents what it adds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DemoRefs = Record<string, any>;

export interface CreateContextInput {
  app: FastifyInstance;
  tenantId: string;
  people: DemoContext['people'];
  tokens: Readonly<Record<Actor, string>>;
}

export function createContext(input: CreateContextInput): DemoContext {
  const warnings: string[] = [];

  const send = async (as: Actor, method: string, url: string, body?: Body) => {
    const response = await input.app.inject({
      method: method as 'GET',
      url,
      // A spread of addresses: the per-address rate limit is for strangers,
      // and one seed run would otherwise spend a minute's allowance.
      remoteAddress: `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`,
      headers: {
        authorization: `Bearer ${input.tokens[as]}`,
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        // Writes that must not repeat on a retry insist on one; a fresh key per
        // request is exactly what a client sends.
        ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return response;
  };

  const parse = (text: string): unknown => {
    if (text === '') {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const call: DemoContext['call'] = async (as, method, url, body) => {
    const response = await send(as, method, url, body);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new DemoRequestError(method, url, response.statusCode, response.body);
    }
    return parse(response.body) as never;
  };

  const attempt: DemoContext['attempt'] = async (as, method, url, body) => {
    const response = await send(as, method, url, body);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return parse(response.body) as never;
    }
    if (response.statusCode >= 500) {
      throw new DemoRequestError(method, url, response.statusCode, response.body);
    }
    warnings.push(
      `${method} ${url} answered ${String(response.statusCode)}: ${response.body.slice(0, 300)}`,
    );
    return undefined;
  };

  return {
    tenantId: input.tenantId,
    people: input.people,
    refs: {},
    call,
    attempt,
    log: (message) => {
      console.log(`    ${message}`);
    },
    warn: (message) => {
      warnings.push(message);
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Dates. Everything is relative to today, so the company looks lived-in on the
// day it is seeded: last month's jobs are done, next week's are booked.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** A timestamp `days` from now (negative for the past), at `hour`:`minute` UTC. */
export function at(days: number, hour = 9, minute = 0): string {
  const date = new Date(Date.now() + days * DAY_MS);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
}

/** A `YYYY-MM-DD` date `days` from today. */
export function day(days: number): string {
  return at(days).slice(0, 10);
}

/** The first of the month `months` from this one, as `YYYY-MM-DD`. */
export function monthStart(months = 0): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/** The last day of the month `months` from this one, as `YYYY-MM-DD`. */
export function monthEnd(months = 0): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
