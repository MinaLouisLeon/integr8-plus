import type { Principal } from '@integr8/core';

/**
 * Structured JSON logging, with the request's identity on every line.
 *
 * The property this exists for is P04's fourth exit criterion: every line
 * belonging to one request carries the same `requestId`, and the caller is
 * given that id too. Without it, "a customer says something failed at about
 * half past two" is not an answerable question.
 *
 * JSON rather than a formatted line because these are read by a machine first
 * — a log search, an alert — and by a person second.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * Fields attached to every line a logger writes.
 *
 * `requestId` is the one that matters; the rest make a log search useful
 * without a join. `tenantId` in particular means a customer-specific
 * investigation is one filter rather than a correlation exercise.
 */
export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  /** Present only while a super admin is acting as somebody else. */
  impersonatedBy?: string;
  method?: string;
  path?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug: (message: string, fields?: Record<string, unknown>) => void;
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
  /** A logger carrying everything this one does, plus more. */
  child: (context: LogContext) => Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  context?: LogContext;
  /** Injectable sink. Tests capture lines; production writes to stdout. */
  write?: (line: string) => void;
  now?: () => Date;
  service?: string;
  release?: string;
}

/**
 * Keys whose values are never written to a log.
 *
 * A log line is copied into a ticket, a chat message, a screenshot. Anything
 * here would be a live credential the moment it were.
 */
const REDACTED = new Set([
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'offlineGrant',
  'authorization',
  'apikey',
  'secret',
  'idempotencyKey',
  'serviceRoleKey',
]);

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date());
  const base: LogContext = { ...options.context };

  if (options.service !== undefined) {
    base.service = options.service;
  }
  if (options.release !== undefined) {
    base.release = options.release;
  }

  const log = (entry: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (SEVERITY[entry] < SEVERITY[level]) {
      return;
    }

    write(
      JSON.stringify({
        level: entry,
        time: now().toISOString(),
        message,
        ...redact(base),
        ...redact(fields ?? {}),
      }),
    );
  };

  return {
    debug: (message, fields) => {
      log('debug', message, fields);
    },
    info: (message, fields) => {
      log('info', message, fields);
    },
    warn: (message, fields) => {
      log('warn', message, fields);
    },
    error: (message, fields) => {
      log('error', message, fields);
    },
    child: (context) =>
      createLogger({
        ...options,
        level,
        write,
        now,
        context: { ...base, ...context },
      }),
  };
}

/** Replaces the value of any sensitive key, at any depth. */
function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED.has(key)) {
      out[key] = '[redacted]';
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }

  return out;
}

/** The log fields a verified principal contributes. */
export function principalContext(principal: Principal): LogContext {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    sessionId: principal.sessionId,
    ...(principal.impersonatedBy === undefined
      ? {}
      : { impersonatedBy: principal.impersonatedBy.pid }),
  };
}
