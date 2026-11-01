import { describe, expect, it } from 'vitest';
import { buildAppBuildTrigger } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { GitHubAppBuildTrigger, RecordingAppBuildTrigger } from './app-builds.js';

/**
 * Starting a company's app build from the dashboard (P15). GitHub is a
 * stand-in here: what is ours is what is asked for, how each answer is read,
 * and that a half-set switch refuses to start.
 */

interface Sent {
  url: string;
  init: RequestInit;
  body: { ref: string; inputs: { company: string }; return_run_details?: boolean };
}

function github(...answers: Response[]) {
  const sent: Sent[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'];
    sent.push({ url, init: init ?? {}, body });
    const answer = answers.shift();
    return answer === undefined
      ? Promise.reject(new Error('no answer left'))
      : Promise.resolve(answer);
  };
  const trigger = new GitHubAppBuildTrigger({
    token: 'github_pat_test',
    repository: 'integr8/integr8-plus',
    ref: 'main',
    fetch: fetcher,
  });
  return { sent, trigger };
}

const RUNS = 'https://github.com/integr8/integr8-plus/actions/workflows/build-company-apps.yml';

describe('asking GitHub to build one company', () => {
  it('dispatches the company workflow on the build branch, for that company only', async () => {
    const { sent, trigger } = github(new Response(null, { status: 204 }));
    await trigger.start('acme');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      'https://api.github.com/repos/integr8/integr8-plus/actions/workflows/build-company-apps.yml/dispatches',
    );
    expect(sent[0]?.init.method).toBe('POST');
    expect((sent[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer github_pat_test',
    );
    expect(sent[0]?.body).toEqual({
      ref: 'main',
      inputs: { company: 'acme' },
      return_run_details: true,
    });
  });

  it('links the run itself when GitHub names it', async () => {
    const { trigger } = github(
      Response.json({
        workflow_run_id: 42,
        run_url: 'https://api.github.com/repos/integr8/integr8-plus/actions/runs/42',
        html_url: 'https://github.com/integr8/integr8-plus/actions/runs/42',
      }),
    );
    expect(await trigger.start('acme')).toEqual({
      status: 'started',
      runsUrl: RUNS,
      runUrl: 'https://github.com/integr8/integr8-plus/actions/runs/42',
    });
  });

  it('links the list of runs when GitHub only says it started one', async () => {
    const { trigger } = github(new Response(null, { status: 204 }));
    expect(await trigger.start('acme')).toEqual({ status: 'started', runsUrl: RUNS, runUrl: null });
  });

  it('asks again without run details when this GitHub does not know the flag', async () => {
    const { sent, trigger } = github(
      Response.json(
        { message: 'Invalid request. "return_run_details" is not a permitted key.' },
        { status: 422 },
      ),
      new Response(null, { status: 204 }),
    );
    expect((await trigger.start('acme')).status).toBe('started');
    expect(sent[1]?.body.return_run_details).toBeUndefined();
  });

  it('says what to check when GitHub refuses, rather than throwing', async () => {
    const refused = await github(
      Response.json(
        { message: 'Resource not accessible by personal access token' },
        { status: 403 },
      ),
    ).trigger.start('acme');
    expect(refused.status).toBe('failed');
    expect(refused.status === 'failed' ? refused.message : '').toMatch(
      /403.*Actions: read and write/u,
    );

    const unreachable = await github().trigger.start('acme');
    expect(unreachable.status === 'failed' ? unreachable.message : '').toMatch(
      /could not be reached/u,
    );
  });
});

describe('the APP_BUILDS switch', () => {
  it('is off by default: builds are started by hand, and the request is only recorded', async () => {
    const trigger = buildAppBuildTrigger(loadApiConfig({}));
    expect(trigger).toBeInstanceOf(RecordingAppBuildTrigger);
    expect(await trigger.start('acme')).toEqual({ status: 'not_configured' });
  });

  it('refuses to start half-configured', () => {
    expect(() => loadApiConfig({ APP_BUILDS: 'github' })).toThrow(
      /GITHUB_BUILD_TOKEN and GITHUB_BUILD_REPOSITORY not set/u,
    );
    expect(() =>
      loadApiConfig({ APP_BUILDS: 'github', GITHUB_BUILD_REPOSITORY: 'integr8/integr8-plus' }),
    ).toThrow(/GITHUB_BUILD_TOKEN not set/u);
    expect(() =>
      loadApiConfig({ APP_BUILDS: 'github', GITHUB_BUILD_TOKEN: 'github_pat_x' }),
    ).toThrow(/GITHUB_BUILD_REPOSITORY not set/u);
  });

  it('builds through GitHub once both are set, on main unless told otherwise', () => {
    const config = loadApiConfig({
      APP_BUILDS: 'github',
      GITHUB_BUILD_TOKEN: 'github_pat_x',
      GITHUB_BUILD_REPOSITORY: 'integr8/integr8-plus',
    });
    expect(config.GITHUB_BUILD_REF).toBe('main');
    expect(buildAppBuildTrigger(config).provider).toBe('github');
  });
});
