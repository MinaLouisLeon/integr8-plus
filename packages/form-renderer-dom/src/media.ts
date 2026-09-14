import type { MediaReference } from '@integr8/form-engine';

/**
 * How the renderer stores and shows files, supplied by the app.
 *
 * The renderer knows nothing about the API, tokens or storage. The web app and
 * the desktop app each implement this over their own authenticated client, and
 * a test implements it in memory — which is also why the same widgets will keep
 * working when P09 moves the bytes to R2.
 */
export interface MediaAdapter {
  /** Uploads the bytes and returns the reference an answer stores. */
  upload(
    file: Blob,
    options: {
      contentType: string;
      onProgress?: (fraction: number) => void;
      signal?: AbortSignal;
    },
  ): Promise<MediaReference>;

  /** A URL the browser can load right now to show or open the file. */
  url(reference: MediaReference): Promise<string>;
}
