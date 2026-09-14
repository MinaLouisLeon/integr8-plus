/**
 * What Cloudflare says a bucket holds, from its GraphQL Analytics API.
 *
 * This is the number Cloudflare bills from, so it is what the ledger is checked
 * against. It is reported per bucket — the reason every company has its own —
 * and it is sampled periodically, so a change shows up after a delay rather than
 * at once.
 */

export interface BucketAnalytics {
  /** Bytes of object data: what `files.byte_size` and thumbnails add up to. */
  payloadSize: number;
  metadataSize: number;
  objectCount: number;
  uploadCount: number;
  /** When Cloudflare sampled these figures. */
  sampledAt: Date;
}

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

const QUERY = `
query BucketStorage($accountTag: string!, $bucketName: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2StorageAdaptiveGroups(
        limit: 1
        filter: { bucketName: $bucketName, datetime_geq: $since, datetime_leq: $until }
        orderBy: [datetime_DESC]
      ) {
        max { objectCount uploadCount payloadSize metadataSize }
        dimensions { datetime }
      }
    }
  }
}`;

interface GraphQlResponse {
  data?: {
    viewer?: {
      accounts?: {
        r2StorageAdaptiveGroups?: {
          max: {
            objectCount: number;
            uploadCount: number;
            payloadSize: number;
            metadataSize: number;
          };
          dimensions: { datetime: string };
        }[];
      }[];
    };
  };
  errors?: { message: string }[] | null;
}

/** The latest sample for a bucket in the last week, or `undefined` if Cloudflare has none. */
export async function fetchBucketAnalytics(options: {
  accountId: string;
  apiToken: string;
  bucket: string;
  now?: Date;
  fetch?: typeof fetch;
}): Promise<BucketAnalytics | undefined> {
  const now = options.now ?? new Date();
  const response = await (options.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        accountTag: options.accountId,
        bucketName: options.bucket,
        since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        until: now.toISOString(),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare analytics answered ${String(response.status)}.`);
  }
  const body = (await response.json()) as GraphQlResponse;
  if (body.errors !== undefined && body.errors !== null && body.errors.length > 0) {
    throw new Error(
      `Cloudflare analytics: ${body.errors.map((error) => error.message).join('; ')}`,
    );
  }
  const sample = body.data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups?.[0];
  if (sample === undefined) {
    return undefined;
  }
  return {
    payloadSize: sample.max.payloadSize,
    metadataSize: sample.max.metadataSize,
    objectCount: sample.max.objectCount,
    uploadCount: sample.max.uploadCount,
    sampledAt: new Date(sample.dimensions.datetime),
  };
}
