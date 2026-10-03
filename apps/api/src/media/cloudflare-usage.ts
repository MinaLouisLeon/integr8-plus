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

// ---------------------------------------------------------------------------
// What a bucket cost, rather than what it holds (P16)
// ---------------------------------------------------------------------------

/**
 * Operations against a bucket over a window, by billing class.
 *
 * Cloudflare charges for storage and for operations separately, and the two
 * have nothing to do with each other: a company storing very little can cost
 * more than one storing a great deal, if their phones sync often enough. Class
 * A is the expensive kind — writes and lists; Class B is reads. Neither is
 * visible in the ledger, because neither leaves anything in a bucket.
 */
export interface BucketOperations {
  classA: number;
  classB: number;
  /** The window these cover. */
  since: Date;
  until: Date;
}

const OPERATIONS_QUERY = `
query BucketOperations($accountTag: string!, $bucketName: string!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      r2OperationsAdaptiveGroups(
        limit: 100
        filter: { bucketName: $bucketName, datetime_geq: $since, datetime_leq: $until }
      ) {
        sum { requests }
        dimensions { actionType }
      }
    }
  }
}`;

interface OperationsResponse {
  data?: {
    viewer?: {
      accounts?: {
        r2OperationsAdaptiveGroups?: {
          sum: { requests: number };
          dimensions: { actionType: string };
        }[];
      }[];
    };
  };
  errors?: { message: string }[] | null;
}

/**
 * Which action types Cloudflare bills as Class A.
 *
 * Listed rather than inferred: Cloudflare's own documentation is the source,
 * and an action type that appears later should be counted deliberately rather
 * than silently falling into whichever bucket a default chose. Anything not
 * named here is counted as Class B, which is the cheaper of the two — so a new
 * action type understates the bill rather than inventing one.
 */
const CLASS_A_ACTIONS = new Set([
  'ListBuckets',
  'PutBucket',
  'ListObjects',
  'PutObject',
  'CopyObject',
  'CompleteMultipartUpload',
  'CreateMultipartUpload',
  'UploadPart',
  'UploadPartCopy',
  'ListMultipartUploads',
  'PutBucketEncryption',
  'PutBucketCors',
  'PutBucketLifecycleConfiguration',
  'LifecycleStorageTierTransition',
]);

/** Operations against a bucket over a window, or `undefined` when Cloudflare has none. */
export async function fetchBucketOperations(options: {
  accountId: string;
  apiToken: string;
  bucket: string;
  since: Date;
  until?: Date;
  fetch?: typeof fetch;
}): Promise<BucketOperations | undefined> {
  const until = options.until ?? new Date();
  const response = await (options.fetch ?? fetch)(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: OPERATIONS_QUERY,
      variables: {
        accountTag: options.accountId,
        bucketName: options.bucket,
        since: options.since.toISOString(),
        until: until.toISOString(),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare analytics answered ${String(response.status)}.`);
  }
  const body = (await response.json()) as OperationsResponse;
  if (body.errors !== undefined && body.errors !== null && body.errors.length > 0) {
    throw new Error(
      `Cloudflare analytics: ${body.errors.map((error) => error.message).join('; ')}`,
    );
  }

  const groups = body.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups;
  if (groups === undefined) {
    return undefined;
  }

  let classA = 0;
  let classB = 0;
  for (const group of groups) {
    if (CLASS_A_ACTIONS.has(group.dimensions.actionType)) {
      classA += group.sum.requests;
    } else {
      classB += group.sum.requests;
    }
  }

  return { classA, classB, since: options.since, until };
}
