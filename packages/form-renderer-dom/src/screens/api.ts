import { ApiRequestError, type Integr8Client, type paths } from '@integr8/api-client';
import type { MediaReference } from '@integr8/form-engine';
import { createContext, useContext } from 'react';
import type { MediaAdapter } from '../media.js';

/**
 * What the submission screens need from the app that hosts them.
 *
 * The web app and the desktop app authenticate differently and route
 * differently; everything else about filling and finding submissions is the
 * same, so that is all they supply.
 */
export interface ScreensConfig {
  client: Integr8Client;
  locale: string;
  navigate: (to: string) => void;
  paths: {
    /**
     * The app's home. When set, the fill and submissions lists offer a way
     * back to it; when not, the app's own shell owns that navigation.
     */
    dashboard?: string;
    fill: string;
    submissions: string;
    submission: (id: string) => string;
    /** A job. When set, a submission made for a job offers a way back to it. */
    workOrder?: (id: string) => string;
  };
  /** Saves a file the person asked for, such as a CSV export. */
  download: (blob: Blob, filename: string) => void;
  /**
   * A row's own menu, such as the desktop app's right-click menu. When set,
   * right-clicking a submission row calls it with the same actions the row
   * offers, and the browser's menu is not shown. When not set, rows keep the
   * browser's menu.
   */
  rowActions?: SubmissionRowActionsHandler;
}

/** What a row is about, for a row menu. */
export interface SubmissionRowTarget {
  kind: 'submission';
  id: string;
  label: string;
}

/** One entry of a row menu: already translated, and doing what the row's own control does. */
export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/** The pointer event that opened a row menu: where, and how to stop the browser's own. */
export interface RowActionsEvent {
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

export type SubmissionRowActionsHandler = (
  target: SubmissionRowTarget,
  actions: readonly RowAction[],
  event: RowActionsEvent,
) => void;

export const ScreensContext = createContext<ScreensConfig | undefined>(undefined);

export function useScreens(): ScreensConfig {
  const config = useContext(ScreensContext);
  if (config === undefined) {
    throw new Error('Submission screens need a <ScreensContext.Provider>.');
  }
  return config;
}

type Json<
  P extends keyof paths,
  M extends 'get' | 'post' | 'put',
  S extends number,
> = paths[P][M] extends { responses: Record<S, { content: { 'application/json': infer T } }> }
  ? T
  : never;

export type FormList = Json<'/v1/forms', 'get', 200>['items'];
export type FormDetail = Json<'/v1/forms/{formId}', 'get', 200>;
export type SubmissionPage = Json<'/v1/submissions', 'get', 200>;
export type SubmissionSummary = SubmissionPage['items'][number];
export type SubmissionDetail = Json<'/v1/submissions/{submissionId}', 'get', 200>;
export type Me = Json<'/v1/me', 'get', 200>;

export const keys = {
  me: ['me'] as const,
  forms: ['forms'] as const,
  form: (id: string) => ['forms', id] as const,
  drafts: ['submissions', 'drafts'] as const,
  list: (query: Record<string, unknown>) => ['submissions', 'list', query] as const,
  submission: (id: string) => ['submissions', id] as const,
};

/**
 * The server's field-level reasons, keyed by answer where the detail names one:
 * `body.answers.make`, or inside an entry of a repeatable section (P13b)
 * `body.answers.appliances[<entry id>].make`, which names the entry too.
 */
export function problemsOf(
  error: unknown,
): { field: string | undefined; entry?: string; message: string }[] {
  if (!(error instanceof ApiRequestError)) {
    return [];
  }
  return error.details.map((detail) => {
    if (!detail.field.startsWith('body.answers.')) {
      return { field: undefined, message: detail.message };
    }
    const path = detail.field.slice('body.answers.'.length);
    const inEntry = /^[a-z][a-z0-9_]*\[([A-Za-z0-9_-]+)\]\.([a-z][a-z0-9_]*)$/u.exec(path);
    return inEntry === null
      ? { field: path, message: detail.message }
      : { field: inEntry[2], entry: inEntry[1]!, message: detail.message };
  });
}

/**
 * Media over the API: create the upload, send the bytes to the link it returns,
 * confirm. The same three steps whether the link points at this API's local
 * store or at R2.
 *
 * XMLHttpRequest for the bytes, because `fetch` cannot report upload progress
 * and a photo over a weak signal takes long enough for that to matter.
 */
export function apiMediaAdapter(client: Integr8Client): MediaAdapter {
  const links = new Map<string, { url: string; expiresAt: number }>();

  return {
    async upload(file, options) {
      const created = (
        await client.POST('/v1/media', {
          params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
          body: { contentType: options.contentType, byteSize: file.size },
        })
      ).data!;

      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open(created.upload.method, created.upload.url);
        for (const [name, value] of Object.entries(created.upload.headers)) {
          request.setRequestHeader(name, value);
        }
        request.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            options.onProgress?.(event.loaded / event.total);
          }
        };
        request.onload = () =>
          request.status < 300 ? resolve() : reject(new Error(String(request.status)));
        request.onerror = () => reject(new Error('network'));
        options.signal?.addEventListener('abort', () => request.abort());
        request.send(file);
      });

      // The reference carries what storage confirmed, not what was declared.
      const stored = (
        await client.POST('/v1/media/{mediaId}/complete', {
          params: { path: { mediaId: created.media.id } },
        })
      ).data!;
      return {
        mediaId: stored.id,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
      } satisfies MediaReference;
    },

    async url(reference) {
      const known = links.get(reference.mediaId);
      if (known !== undefined && known.expiresAt - 30_000 > Date.now()) {
        return known.url;
      }
      const found = (
        await client.GET('/v1/media/{mediaId}', {
          params: { path: { mediaId: reference.mediaId } },
        })
      ).data!;
      links.set(reference.mediaId, { url: found.url, expiresAt: Date.parse(found.expiresAt) });
      return found.url;
    },
  };
}

/** Today in the filler's own calendar, `YYYY-MM-DD`: what "before today" means where they are. */
export function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
