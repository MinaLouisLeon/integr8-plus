import { appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAuthPath, redact, redactHeaders } from './redact.js';

/**
 * Every request the server sends and every answer, for the AI tool to read
 * back (`get_trace`) and for the person to read along: one JSON Lines file
 * per session in the temporary folder. Secrets are hidden before anything is
 * kept, in memory or on disk.
 */

export interface TraceEntry {
  id: number;
  at: string;
  /** Who sent it: `staff`, `company`, or the person acted as. */
  as: string;
  method: string;
  path: string;
  query: Record<string, string>;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  durationMs: number;
  /** The API's own request id, to find the line in its log and audit. */
  requestId: string | null;
  error?: string;
}

export type NewTraceEntry = Omit<TraceEntry, 'id' | 'at'>;

const KEPT_IN_MEMORY = 500;

export class Trace {
  readonly file: string | undefined;
  readonly #entries: TraceEntry[] = [];
  #next = 1;

  constructor(options: { folder?: string; write?: boolean } = {}) {
    if (options.write === false) {
      this.file = undefined;
      return;
    }
    const folder = options.folder ?? join(tmpdir(), 'integr8-dev-mcp');
    mkdirSync(folder, { recursive: true });
    this.file = join(
      folder,
      `trace-${new Date().toISOString().replace(/[:.]/gu, '-')}-${String(process.pid)}.jsonl`,
    );
  }

  record(entry: NewTraceEntry): TraceEntry {
    const authPath = isAuthPath(entry.path);
    const kept: TraceEntry = {
      ...entry,
      id: this.#next,
      at: new Date().toISOString(),
      query: redact(entry.query) as Record<string, string>,
      requestHeaders: redactHeaders(entry.requestHeaders),
      requestBody: redact(entry.requestBody, { authPath }),
      responseHeaders: redactHeaders(entry.responseHeaders),
      responseBody: redact(entry.responseBody, { authPath }),
    };
    this.#next += 1;
    this.#entries.push(kept);
    if (this.#entries.length > KEPT_IN_MEMORY) {
      this.#entries.shift();
    }
    if (this.file !== undefined) {
      appendFileSync(this.file, `${JSON.stringify(kept)}\n`, { mode: 0o600 });
    }
    return kept;
  }

  /** Newest first. */
  recent(limit = 20): TraceEntry[] {
    return this.#entries.slice(-limit).reverse();
  }

  find(id: number): TraceEntry | undefined {
    return this.#entries.find((entry) => entry.id === id);
  }
}
