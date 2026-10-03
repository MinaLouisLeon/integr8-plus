import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildMediaStorage } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { fetchBucketAnalytics } from './cloudflare-usage.js';
import { R2Storage } from './r2.js';
import {
  BUCKET_PATTERN,
  categoryOf,
  mediaKey,
  OBJECT_KEY_PATTERN,
  thumbnailKey,
} from './storage.js';
import { renderThumbnail, THUMBNAIL_EDGE } from './thumbnails.js';

const ID = '0b6f1f7e-6f7a-4c1e-9a55-3b0d1f4f2a10';

describe('object keys and bucket names', () => {
  it('writes only keys that cannot climb out of their bucket', () => {
    expect(OBJECT_KEY_PATTERN.test(mediaKey(ID))).toBe(true);
    expect(OBJECT_KEY_PATTERN.test(thumbnailKey(ID))).toBe(true);
    for (const key of ['../etc/passwd', '/media/x', 'media/../x', 'media//x', 'Media/X', '']) {
      expect(OBJECT_KEY_PATTERN.test(key), key).toBe(false);
    }
  });

  it('names a bucket from the company id within R2’s rules, whatever the environment', () => {
    for (const appEnv of ['development', 'test', 'staging', 'production']) {
      const config = loadApiConfig({
        APP_ENV: appEnv,
        MEDIA_STORAGE: 'r2',
        CLOUDFLARE_ACCOUNT_ID: 'account',
        R2_ACCESS_KEY_ID: 'key',
        R2_SECRET_ACCESS_KEY: 'secret',
        API_CORS_ORIGINS: 'https://app.integr8.example',
      });
      const storage = buildMediaStorage(config);
      expect(storage).toBeInstanceOf(R2Storage);
      const bucket = storage.bucketFor(ID);
      expect(bucket).toBe(`integr8-${appEnv}-${ID}`);
      expect(BUCKET_PATTERN.test(bucket)).toBe(true);
    }
  });
});

describe('media categories', () => {
  it('reports each upload under the kind of thing it is', () => {
    expect(categoryOf('image/jpeg')).toBe('image');
    expect(categoryOf('video/mp4')).toBe('video');
    expect(categoryOf('application/pdf')).toBe('document');
    expect(categoryOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(
      'document',
    );
    expect(categoryOf('application/zip')).toBe('other');
  });
});

describe('R2 configuration', () => {
  it('refuses to start on R2 without the account and token, naming what is missing', () => {
    expect(() => loadApiConfig({ MEDIA_STORAGE: 'r2', CLOUDFLARE_ACCOUNT_ID: 'account' })).toThrow(
      /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/u,
    );
  });

  it('refuses a bucket prefix that would make an invalid bucket name', () => {
    expect(() => loadApiConfig({ R2_BUCKET_PREFIX: 'Has_Capitals' })).toThrow(/R2_BUCKET_PREFIX/u);
  });

  it('signs an upload link for exactly one type and one size, carrying no credentials', async () => {
    const storage = new R2Storage({
      accountId: 'account',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'a-secret-that-must-not-leak',
      bucketPrefix: 'integr8-test',
      corsOrigins: [],
    });
    const target = await storage.open(`integr8-test-${ID}`).createUpload({
      key: mediaKey(ID),
      contentType: 'image/jpeg',
      byteSize: 1234,
      expiresInSeconds: 900,
    });
    const url = new URL(target.url);
    expect(url.host).toBe(`account.r2.cloudflarestorage.com`);
    expect(url.pathname).toBe(`/integr8-test-${ID}/media/${ID}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(target.url).not.toContain('a-secret-that-must-not-leak');
    expect(target.url).not.toMatch(/checksum/iu);
    expect(target.headers).toEqual({ 'content-type': 'image/jpeg' });
  });
});

describe('Cloudflare analytics', () => {
  it('reads the latest storage sample for one bucket', async () => {
    let sent: { url: string; body: string; headers: Record<string, string> } | undefined;
    const fake: typeof fetch = (url, init) => {
      sent = {
        url: url instanceof Request ? url.url : url.toString(),
        body: typeof init?.body === 'string' ? init.body : '',
        headers: init?.headers as Record<string, string>,
      };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                accounts: [
                  {
                    r2StorageAdaptiveGroups: [
                      {
                        max: {
                          objectCount: 3,
                          uploadCount: 3,
                          payloadSize: 98_765,
                          metadataSize: 120,
                        },
                        dimensions: { datetime: '2026-09-14T09:00:00Z' },
                      },
                    ],
                  },
                ],
              },
            },
            errors: null,
          }),
        ),
      );
    };
    const result = await fetchBucketAnalytics({
      accountId: 'account',
      apiToken: 'token',
      bucket: 'integr8-test-bucket',
      fetch: fake,
    });
    expect(sent?.url).toBe('https://api.cloudflare.com/client/v4/graphql');
    expect(result).toEqual({
      payloadSize: 98_765,
      metadataSize: 120,
      objectCount: 3,
      uploadCount: 3,
      sampledAt: new Date('2026-09-14T09:00:00Z'),
    });
    const body = JSON.parse(sent!.body) as { variables: Record<string, string> };
    expect(body.variables).toMatchObject({
      accountTag: 'account',
      bucketName: 'integr8-test-bucket',
    });
    expect(sent!.headers.authorization).toBe('Bearer token');
  });

  it('says so when Cloudflare refuses the query', async () => {
    const fake: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: null, errors: [{ message: 'not authorized' }] })),
      );
    await expect(
      fetchBucketAnalytics({
        accountId: 'a',
        apiToken: 't',
        bucket: 'b-b-b',
        fetch: fake,
      }),
    ).rejects.toThrow(/not authorized/u);
  });
});

describe('thumbnails', () => {
  it('fits the longest edge, keeps the aspect ratio, and never enlarges', async () => {
    const wide = await sharp({
      create: { width: 4000, height: 1000, channels: 3, background: '#000' },
    })
      .jpeg()
      .toBuffer();
    const small = await sharp({
      create: { width: 100, height: 50, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    const wideThumb = await sharp(await renderThumbnail(wide)).metadata();
    const smallThumb = await sharp(await renderThumbnail(small)).metadata();
    expect([wideThumb.format, wideThumb.width, wideThumb.height]).toEqual([
      'webp',
      THUMBNAIL_EDGE,
      80,
    ]);
    expect([smallThumb.width, smallThumb.height]).toEqual([100, 50]);
  });

  it('turns a photo the way its camera said it was held', async () => {
    const sideways = await sharp({
      create: { width: 600, height: 300, channels: 3, background: '#fff' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const thumb = await sharp(await renderThumbnail(sideways)).metadata();
    expect([thumb.width, thumb.height]).toEqual([160, 320]);
  });

  it('refuses what is not an image', async () => {
    await expect(renderThumbnail(new TextEncoder().encode('not an image'))).rejects.toThrow();
  });
});
