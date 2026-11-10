import type { MediaReference } from '@integr8/form-engine';
import type { MediaAdapter } from '@integr8/form-renderer-dom';

/**
 * How the page talks to the program that serves it: same origin, the token
 * from the page's own address on every request, JSON both ways. Nothing
 * here can reach another host (the server's Content-Security-Policy says
 * `connect-src 'self'`).
 */

export type Tab = 'form' | 'pdf' | 'checks';

export interface Problem {
  code: string;
  message: string;
  path: string;
  entry: string;
}

export interface PrintState {
  status: 'waiting' | 'printing' | 'ready' | 'failed' | 'unavailable';
  version: number;
  options: { useAnswers: boolean; language?: 'en' | 'ar'; companyColour?: string };
  by: 'window' | 'ai';
  at: string;
  message: string | null;
  pageCount: number | null;
}

export interface WindowState {
  version: number;
  hasContent: boolean;
  definition: unknown;
  templates: { name: string; language: 'en' | 'ar' | null }[];
  check: { ok: boolean; problems: Problem[]; warnings: Problem[] } | null;
  checkText: string;
  summary: string;
  answers: Record<string, unknown>;
  submitted: { at: string; answers: Record<string, unknown> } | null;
  prints: Record<string, PrintState | undefined>;
  printing: { available: boolean };
  view: { tab: Tab; language: 'en' | 'ar'; width: 'phone' | 'desktop'; theme: 'light' | 'dark' };
  outputFolder: string;
}

export interface ChangeRequestRow {
  number: number;
  title: string;
  kind: string;
  status: 'open' | 'merged' | 'dropped' | 'handed_over';
  date: string;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface WindowApi {
  /** Adds the token to a path on this server, for links and frames. */
  href(path: string): string;
  state(): Promise<WindowState>;
  /** The change requests recorded on this computer (P39). */
  requests(): Promise<ChangeRequestRow[]>;
  post(path: string, body: unknown): Promise<Record<string, unknown>>;
  /** Opens the event stream; returns how to close it. */
  events(handlers: {
    onOpen: () => void;
    onError: () => void;
    onState: () => void;
    onPdf: () => void;
  }): () => void;
  media: MediaAdapter;
}

export function windowApi(token: string): WindowApi {
  const href = (path: string) => `${path}${path.includes('?') ? '&' : '?'}k=${token}`;
  let queue: Promise<unknown> = Promise.resolve();

  const read = async (response: Response) => {
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new RequestError(
        response.status,
        typeof body.error === 'string' ? body.error : response.statusText,
        body,
      );
    }
    return body;
  };

  return {
    href,
    async state() {
      return (await read(await fetch(href('/state')))) as unknown as WindowState;
    },
    async requests() {
      return ((await read(await fetch(href('/requests')))) as { items: ChangeRequestRow[] }).items;
    },
    post(path, body) {
      // One at a time, in order: answers typed just before opening the PDF tab
      // reach the program before the print that should use them.
      const sent = queue.then(async () =>
        read(
          await fetch(href(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        ),
      );
      queue = sent.catch(() => undefined);
      return sent;
    },
    events({ onOpen, onError, onState, onPdf }) {
      const source = new EventSource(href('/events'));
      source.addEventListener('open', onOpen);
      source.addEventListener('error', onError);
      source.addEventListener('state', onState);
      source.addEventListener('pdf', onPdf);
      return () => {
        source.close();
      };
    },
    media: {
      async upload(file, options): Promise<MediaReference> {
        options.onProgress?.(0);
        const body = await read(
          await fetch(href('/media'), {
            method: 'POST',
            headers: { 'Content-Type': options.contentType },
            body: file,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
        );
        options.onProgress?.(1);
        return body as unknown as MediaReference;
      },
      url(reference) {
        return Promise.resolve(href(`/media/${reference.mediaId}`));
      },
    },
  };
}
