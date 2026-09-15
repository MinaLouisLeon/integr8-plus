import type { Integr8Client } from '@integr8/api-client';
import { ApiRequestError } from '@integr8/api-client';
import type {
  ArrivedParts,
  CustomerDetail,
  Me,
  PartLinks,
  PreparedUpload,
  PullPage,
  PushRequest,
  PushResponse,
  SyncReport,
  WorkOrderDetail,
} from '../api-types.js';

/**
 * Everything sync needs from outside: the API, the bytes of files, and a way to
 * send bytes to storage. The phone supplies Expo implementations; tests supply
 * Node ones, or ones that fail on purpose.
 */

export interface SyncApi {
  me(): Promise<Me>;
  workOrder(workOrderId: string): Promise<WorkOrderDetail | undefined>;
  customer(customerId: string): Promise<CustomerDetail | undefined>;
  pull(query: { cursor?: string; page?: string; retentionDays: number }): Promise<PullPage>;
  push(body: PushRequest): Promise<PushResponse>;
  reports(reports: readonly SyncReport[]): Promise<void>;
  prepareUpload(
    mediaId: string,
    body: { contentType: string; byteSize: number },
  ): Promise<PreparedUpload>;
  partLinks(mediaId: string, partNumbers: readonly number[]): Promise<PartLinks>;
  arrivedParts(mediaId: string): Promise<ArrivedParts>;
  completeUpload(mediaId: string): Promise<void>;
  /** A short-lived link to a stored file; undefined when it is gone or not this person's to see. */
  mediaLink(fileId: string): Promise<{ url: string } | undefined>;
}

/** Reads a stored file a piece at a time, so a 25 MB video is never all in memory. */
export interface FileSource {
  exists(path: string): Promise<boolean>;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
}

/** Sends bytes to a presigned link. Throws when there is no connection; answers the status otherwise. */
export interface ByteTransport {
  put(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
  ): Promise<{ status: number }>;
  /** Saves a link's bytes at a path relative to the files directory (P14). */
  download(url: string, path: string): Promise<{ status: number }>;
}

export function syncApiFor(client: Integr8Client): SyncApi {
  return {
    me: async () => (await client.GET('/v1/me')).data!,
    workOrder: (workOrderId) =>
      unlessGone(
        async () =>
          (await client.GET('/v1/work-orders/{workOrderId}', { params: { path: { workOrderId } } }))
            .data,
      ),
    customer: (customerId) =>
      unlessGone(
        async () =>
          (
            await client.GET('/v1/customers/{customerId}', {
              params: { path: { customerId }, query: {} },
            })
          ).data,
      ),
    pull: async (query) => (await client.GET('/v1/sync/pull', { params: { query } })).data!,
    push: async (body) => (await client.POST('/v1/sync/push', { body })).data!,
    reports: async (reports) => {
      await client.POST('/v1/sync/reports', { body: { reports: [...reports] } });
    },
    prepareUpload: async (mediaId, body) =>
      (await client.PUT('/v1/media/{mediaId}', { params: { path: { mediaId } }, body })).data!,
    partLinks: async (mediaId, partNumbers) =>
      (
        await client.POST('/v1/media/{mediaId}/parts', {
          params: { path: { mediaId } },
          body: { partNumbers: [...partNumbers] },
        })
      ).data!,
    arrivedParts: async (mediaId) =>
      (await client.GET('/v1/media/{mediaId}/parts', { params: { path: { mediaId } } })).data!,
    completeUpload: async (mediaId) => {
      await client.POST('/v1/media/{mediaId}/complete', { params: { path: { mediaId } } });
    },
    mediaLink: (fileId) =>
      unlessGone(async () => {
        const data = (
          await client.GET('/v1/media/{mediaId}', { params: { path: { mediaId: fileId } } })
        ).data;
        return data === undefined ? undefined : { url: data.url };
      }),
  };
}

/** A record the person can no longer see is simply not there. */
async function unlessGone<T>(request: () => Promise<T | undefined>): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 404 || error.status === 403)) {
      return undefined;
    }
    throw error;
  }
}
