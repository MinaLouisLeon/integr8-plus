import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../../testing/api-harness.js';

/**
 * A company's apps from the staff app (0023): its installers, how its phone
 * app is published, and the app stores' reviewer account, which holds no seat.
 */

const BUILD_TOKEN = 'a-build-token-long-enough-to-pass-the-minimum-length';

let api: ApiHarness;
let full: PlatformAdmin;
let limited: PlatformAdmin;
let owner: Member;
let ownerToken: string;
let slug: string;

beforeAll(async () => {
  api = await startApi({ env: { BUILD_TOKEN } });
  full = await api.platformAdmin('phone-apps');
  limited = await api.platformAdmin('phone-apps-developer', { scope: 'test_companies' });
  owner = await api.member('owner', 'phone-apps-owner');
  ownerToken = await api.signIn(owner);
  slug = (await getPlatformDataSource().tenants.findById(api.tenantId))?.slug ?? '';
});

afterAll(async () => {
  await api.close();
});

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function errorCode(body: string): string | undefined {
  return (JSON.parse(body) as { error?: { code?: string } }).error?.code;
}

const company = () => `/v1/platform/companies/${api.tenantId}`;

describe('a company’s installers', () => {
  it('are listed for full staff, as nothing when this server reads no releases', async () => {
    const response = await api.call(full.accessToken, { method: 'GET', url: `${company()}/apps` });
    expect(response.statusCode, response.body).toBe(200);
    expect(json(response)).toEqual({ status: 'none' });
  });

  it('are refused to a session limited to test companies', async () => {
    const response = await api.call(limited.accessToken, {
      method: 'GET',
      url: `${company()}/apps`,
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response.body)).toBe('session_scope');
  });
});

describe('how the phone app is published', () => {
  it('starts as an APK staff send, with no store links', async () => {
    const detail = await api.call(full.accessToken, { method: 'GET', url: company() });
    expect(json<{ settings: Record<string, unknown> }>(detail).settings).toMatchObject({
      phoneDistribution: 'apk',
      playTrack: 'internal',
      appStoreId: null,
    });
    const brand = await api.app.inject({
      method: 'GET',
      url: `/v1/public/companies/${slug}/brand`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
    });
    expect(json<{ storeLinks: unknown }>(brand).storeLinks).toBeNull();
  });

  it('refuses an App Store number that is not one', async () => {
    const response = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `${company()}/settings`,
      payload: { appStoreId: 'not-digits' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('switches to the company’s own stores, which the brand and the build list then say', async () => {
    const response = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `${company()}/settings`,
      payload: {
        appsEnabled: true,
        phoneDistribution: 'stores',
        playTrack: 'production',
        appStoreId: '1234567890',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json(response)).toMatchObject({
      phoneDistribution: 'stores',
      playTrack: 'production',
      appStoreId: '1234567890',
    });

    const brand = await api.app.inject({
      method: 'GET',
      url: `/v1/public/companies/${slug}/brand`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
    });
    const links = json<{ storeLinks: { googlePlay: string; appStore: string } }>(brand).storeLinks;
    expect(links.googlePlay).toBe(
      `https://play.google.com/store/apps/details?id=com.integr8.plus.${slug.replaceAll('-', '_')}`,
    );
    expect(links.appStore).toBe('https://apps.apple.com/app/id1234567890');

    const list = await api.app.inject({
      method: 'GET',
      url: '/v1/build/companies',
      headers: {
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
        authorization: `Bearer ${BUILD_TOKEN}`,
      },
    });
    const items = json<{ items: { slug: string; phone: unknown }[] }>(list).items;
    expect(items.find((item) => item.slug === slug)?.phone).toEqual({
      distribution: 'stores',
      playTrack: 'production',
      appStoreId: '1234567890',
    });
  });

  it('is not a limited session’s to change', async () => {
    const response = await api.call(limited.accessToken, {
      method: 'PATCH',
      url: `${company()}/settings`,
      payload: { phoneDistribution: 'apk' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the app stores’ reviewer account', () => {
  let reviewer: { userId: string; email: string; password: string };

  it('is made with a sample job, holds no seat, and signs in', async () => {
    const before = await api.call(full.accessToken, { method: 'GET', url: company() });
    const seatsBefore = json<{ activeMembers: number }>(before).activeMembers;

    const response = await api.call(full.accessToken, {
      method: 'POST',
      url: `${company()}/store-reviewer`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const made = json<{
      created: boolean;
      userId: string;
      email: string;
      password: string;
      workOrderReference: string | null;
    }>(response);
    expect(made.created).toBe(true);
    expect(made.email).toBe(`store-reviewer+${slug}@integr8-media.com`);
    expect(made.password.length).toBeGreaterThanOrEqual(20);
    expect(made.workOrderReference).toMatch(/^WO-/u);
    reviewer = made;

    const after = await api.call(full.accessToken, { method: 'GET', url: company() });
    const detail = json<{ activeMembers: number; storeReviewer: { email: string } | null }>(after);
    expect(detail.activeMembers).toBe(seatsBefore);
    expect(detail.storeReviewer?.email).toBe(made.email);

    // The company sees who it is.
    const members = await api.call(ownerToken, { method: 'GET', url: '/v1/members' });
    const listed = json<{ items: { userId: string; storeReviewer?: boolean; role: string }[] }>(
      members,
    ).items.find((member) => member.userId === made.userId);
    expect(listed).toMatchObject({ storeReviewer: true, role: 'engineer' });

    // The reviewer signs in and sees its one job.
    const token = await api.signIn(
      { userId: made.userId, email: made.email, password: made.password, role: 'engineer' },
      'mobile',
    );
    const jobs = await api.call(token, { method: 'GET', url: '/v1/work-orders' });
    expect(jobs.statusCode, jobs.body).toBe(200);
    expect(jobs.body).toContain('Sample job for the app review');
  });

  it('keeps its role, whoever asks', async () => {
    const response = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${reviewer.userId}/role`,
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe('store_reviewer_role_fixed');
  });

  it('gets a new password, and only one account, when made again', async () => {
    const response = await api.call(full.accessToken, {
      method: 'POST',
      url: `${company()}/store-reviewer`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const again = json<{ created: boolean; userId: string; password: string }>(response);
    expect(again.created).toBe(false);
    expect(again.userId).toBe(reviewer.userId);
    expect(again.password).not.toBe(reviewer.password);
    await expect(api.signIn({ ...reviewer, role: 'engineer' })).rejects.toThrow();
  });

  it('is refused to a session limited to test companies', async () => {
    const response = await api.call(limited.accessToken, {
      method: 'POST',
      url: `${company()}/store-reviewer`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('is removed, and then there is none to remove', async () => {
    const removed = await api.call(full.accessToken, {
      method: 'DELETE',
      url: `${company()}/store-reviewer`,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    const detail = await api.call(full.accessToken, { method: 'GET', url: company() });
    expect(json<{ storeReviewer: unknown }>(detail).storeReviewer).toBeNull();
    const again = await api.call(full.accessToken, {
      method: 'DELETE',
      url: `${company()}/store-reviewer`,
    });
    expect(again.statusCode).toBe(404);
  });
});
