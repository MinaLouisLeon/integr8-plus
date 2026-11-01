import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitHubAppBuildTrigger, RecordingAppBuildTrigger } from '../../../platform/app-builds.js';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * A company's own apps, built from the dashboard (P15). The harness runs with
 * APP_BUILDS off, so the trigger is the recording stand-in: these check when a
 * build is asked for, what the dashboard is told, and what the audit log keeps.
 */

let api: ApiHarness;
let admin: PlatformAdmin;

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin();
});

afterAll(async () => {
  await api.close();
});

function recording(): RecordingAppBuildTrigger {
  const trigger = api.services.appBuilds;
  if (!(trigger instanceof RecordingAppBuildTrigger)) {
    throw new Error('The harness should run with APP_BUILDS off');
  }
  return trigger;
}

async function onboard(): Promise<{ id: string; slug: string }> {
  const slug = `apps-${randomUUID().slice(0, 8)}`;
  const response = await api.call(admin.accessToken, {
    method: 'POST',
    url: '/v1/platform/companies',
    payload: { slug, name: 'Apps Test Ltd', ownerEmail: `owner@${slug}.example` },
  });
  expect(response.statusCode).toBe(201);
  return { id: (JSON.parse(response.body) as { company: { id: string } }).company.id, slug };
}

function saveSettings(tenantId: string, payload: Record<string, unknown>) {
  return api.call(admin.accessToken, {
    method: 'PATCH',
    url: `/v1/platform/companies/${tenantId}/settings`,
    payload,
  });
}

function rebuild(tenantId: string) {
  return api.call(admin.accessToken, {
    method: 'POST',
    url: `/v1/platform/companies/${tenantId}/app-builds`,
    payload: {},
  });
}

interface AppBuild {
  status: string;
  runsUrl: string | null;
  runUrl: string | null;
  message: string | null;
}

describe('switching a company’s apps on', () => {
  it('asks for its first build once, when the switch goes on', async () => {
    const company = await onboard();

    const first = await saveSettings(company.id, { appsEnabled: true });
    expect(first.statusCode).toBe(200);
    const body = JSON.parse(first.body) as { appsEnabled: boolean; appBuild: AppBuild | null };
    expect(body.appsEnabled).toBe(true);
    // APP_BUILDS=off: nothing can start here, and the dashboard says so.
    expect(body.appBuild).toEqual({
      status: 'not_configured',
      runsUrl: null,
      runUrl: null,
      message: null,
    });
    expect(recording().requested.filter((slug) => slug === company.slug)).toHaveLength(1);

    // Saving again with apps already on, or anything else, starts nothing.
    const again = await saveSettings(company.id, { appsEnabled: true, aiWebEnabled: false });
    expect((JSON.parse(again.body) as { appBuild: AppBuild | null }).appBuild).toBeNull();
    const off = await saveSettings(company.id, { appsEnabled: false });
    expect((JSON.parse(off.body) as { appBuild: AppBuild | null }).appBuild).toBeNull();
    expect(recording().requested.filter((slug) => slug === company.slug)).toHaveLength(1);
  });
});

describe('rebuilding a company’s apps', () => {
  it('asks for a build and writes who asked to the audit log', async () => {
    const company = await onboard();
    await saveSettings(company.id, { appsEnabled: true });

    const response = await rebuild(company.id);
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as AppBuild).status).toBe('not_configured');
    expect(recording().requested.filter((slug) => slug === company.slug)).toHaveLength(2);

    const audit = await api.call(admin.accessToken, {
      method: 'GET',
      url: '/v1/platform/audit?action=tenant.app_build_requested',
    });
    const entries = (
      JSON.parse(audit.body) as {
        entries: { tenantSlug: string | null; actorLabel: string; metadata: { reason: string } }[];
      }
    ).entries.filter((entry) => entry.tenantSlug === company.slug);
    expect(entries.map((entry) => entry.metadata.reason).sort()).toEqual([
      'apps_enabled',
      'rebuild',
    ]);
    expect(entries[0]?.actorLabel).toBe(admin.email);
  });

  it('refuses while the company’s apps are switched off, and for a company that does not exist', async () => {
    const company = await onboard();
    const refused = await rebuild(company.id);
    expect(refused.statusCode).toBe(409);
    expect(JSON.parse(refused.body)).toMatchObject({ error: { code: 'apps_not_enabled' } });

    expect((await rebuild(randomUUID())).statusCode).toBe(404);
  });

  it('passes on GitHub’s link to the run it started', async () => {
    const company = await onboard();
    await saveSettings(company.id, { appsEnabled: true });

    const original = api.services.appBuilds;
    api.services.appBuilds = new GitHubAppBuildTrigger({
      token: 'github_pat_test',
      repository: 'integr8/integr8-plus',
      ref: 'main',
      fetch: () =>
        Promise.resolve(
          Response.json({
            workflow_run_id: 7,
            html_url: 'https://github.com/integr8/integr8-plus/actions/runs/7',
          }),
        ),
    });
    try {
      const response = await rebuild(company.id);
      expect(JSON.parse(response.body)).toEqual({
        status: 'started',
        runsUrl: 'https://github.com/integr8/integr8-plus/actions/workflows/build-company-apps.yml',
        runUrl: 'https://github.com/integr8/integr8-plus/actions/runs/7',
        message: null,
      });
    } finally {
      api.services.appBuilds = original;
    }
  });

  it('refuses a company person', async () => {
    const owner = await api.member('owner', 'apps-owner');
    const token = await api.signIn(owner);
    expect(
      (
        await api.call(token, {
          method: 'POST',
          url: `/v1/platform/companies/${api.tenantId}/app-builds`,
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});
