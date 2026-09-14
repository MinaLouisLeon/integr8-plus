/**
 * Where uploaded files' bytes live.
 *
 * The API never streams a client's upload through itself in production: it hands
 * out a short-lived link, the client sends the bytes there directly, and the API
 * then checks what arrived. That is how R2 presigned URLs work (P09), and the
 * local adapter imitates it exactly — its links point back at this server, but
 * the client code that follows them is the same.
 *
 * So swapping local disk for R2 changes this interface's implementation and a
 * config value, and nothing in the routes, the widgets or the submissions.
 */

export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the bytes, exactly. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObject {
  byteSize: number;
  contentType: string;
}

export interface MediaStorage {
  /** A link the client may upload exactly this object to, once, until it expires. */
  createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<UploadTarget>;

  /** What storage holds under `key`, or `undefined` if nothing arrived. */
  stat(key: string): Promise<StoredObject | undefined>;

  /** A short-lived link to read the object. */
  createDownload(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;
}

/**
 * Media types a person may upload.
 *
 * Refused, whatever a form's field says: types a browser would execute or render
 * as a page when the link is opened. An SVG is an image and also a script.
 */
export function isAcceptableMediaType(contentType: string): boolean {
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(contentType)) {
    return false;
  }
  const refused = [
    /^text\/html$/u,
    /^application\/xhtml\+xml$/u,
    /^image\/svg\+xml$/u,
    /xml$/u,
    /javascript/u,
    /^text\/ecmascript$/u,
    /^application\/x-shockwave-flash$/u,
  ];
  return !refused.some((pattern) => pattern.test(contentType));
}
