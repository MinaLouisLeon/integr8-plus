import { describe, expect, it } from 'vitest';
import {
  DesktopUpdateFeed,
  desktopUpdateFeed,
  type GitHubRelease,
  newestRelease,
  publicOrigin,
  tagPattern,
} from './desktop-updates';

/**
 * The desktop update feed (P20): which release each app is offered, read from
 * GitHub at most once per cache window, and passed through only when the
 * repository is private.
 */

function release(tag: string, options: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      {
        id: tag.length,
        name: 'latest.json',
        url: `https://api.github.com/repos/o/r/releases/assets/${tag}`,
        browser_download_url: `https://github.com/o/r/releases/download/${tag}/latest.json`,
      },
    ],
    ...options,
  };
}

const manifest = (tag: string) => ({
  version: tag.replace(/^.*v/u, ''),
  platforms: {
    'windows-x86_64': {
      url: `https://github.com/o/r/releases/download/${tag}/integr8-plus-staff_x64-setup.exe`,
      signature: 'sig',
    },
  },
});

describe('which release an app is offered', () => {
  const releases = [
    release('v1.10.0-nightly.20261030.gabc1234', { prerelease: true }),
    release('company-acme-v1.3.0'),
    release('v1.9.0'),
    release('v1.10.0'),
    release('v1.11.0', { assets: [] }),
    release('v2.0.0', { draft: true }),
    release('company-acme-west-v9.0.0'),
  ];

  it('gives the staff app the highest published `v` release with a manifest', () => {
    expect(newestRelease(releases, 'staff')?.tag_name).toBe('v1.10.0');
  });

  it('gives a company only its own releases, never a company whose name starts the same', () => {
    expect(newestRelease(releases, 'acme')?.tag_name).toBe('company-acme-v1.3.0');
    expect(newestRelease(releases, 'globex')).toBeUndefined();
  });

  it('refuses anything that is not an app name', () => {
    expect(() => tagPattern('../etc')).toThrow();
  });
});

describe('the feed', () => {
  function stubGitHub(releases: GitHubRelease[]) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes('/releases?')) {
        return Promise.resolve(Response.json(releases));
      }
      if (url.endsWith('latest.json') || url.includes('/releases/assets/')) {
        const tag = url.includes('/assets/')
          ? (url.split('/').pop() ?? '')
          : (url.split('/').at(-2) ?? '');
        return Promise.resolve(Response.json(manifest(tag)));
      }
      return Promise.resolve(
        new Response('installer bytes', { headers: { 'content-length': '15' } }),
      );
    };
    return { calls, fetcher };
  }

  it('serves the public manifest as it is, and asks GitHub once per cache window', async () => {
    const github = stubGitHub([release('v1.2.3')]);
    let now = 0;
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      fetch: github.fetcher,
      now: () => now,
    });

    const first = await feed.manifest('staff', 'https://app.example');
    expect(first?.version).toBe('1.2.3');
    expect(first?.platforms['windows-x86_64']?.url).toContain(
      'https://github.com/o/r/releases/download/v1.2.3/',
    );
    await feed.manifest('staff', 'https://app.example');
    expect(github.calls.filter((call) => call.url.includes('/releases?'))).toHaveLength(1);
    expect(github.calls.every((call) => call.headers.authorization === undefined)).toBe(true);

    now = 10 * 60 * 1000;
    await feed.manifest('staff', 'https://app.example');
    expect(github.calls.filter((call) => call.url.includes('/releases?'))).toHaveLength(2);
  });

  it('answers "nothing new" for an app without a release', async () => {
    const feed = new DesktopUpdateFeed({ repository: 'o/r', fetch: stubGitHub([]).fetcher });
    expect(await feed.manifest('acme', 'https://app.example')).toBeUndefined();
  });

  it('keeps the last list when GitHub cannot be reached', async () => {
    const github = stubGitHub([release('v1.2.3')]);
    let failing = false;
    let now = 0;
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      now: () => now,
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        failing ? Promise.reject(new Error('down')) : github.fetcher(input, init),
    });
    await feed.manifest('staff', 'https://app.example');
    failing = true;
    now = 10 * 60 * 1000;
    expect((await feed.manifest('staff', 'https://app.example'))?.version).toBe('1.2.3');
  });

  it('with a token, links downloads back through this server and passes the file through', async () => {
    const github = stubGitHub([release('v1.2.3')]);
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      token: 't0ken',
      fetch: github.fetcher,
    });

    const proxied = await feed.manifest('staff', 'https://app.example/');
    expect(proxied?.platforms['windows-x86_64']?.url).toBe(
      'https://app.example/desktop-updates/staff/download/v1.2.3/integr8-plus-staff_x64-setup.exe',
    );
    expect(github.calls.every((call) => call.headers.authorization === 'Bearer t0ken')).toBe(true);

    // Only a file of that app's own release: the manifest itself is one.
    const file = await feed.download('staff', 'v1.2.3', 'latest.json');
    expect(file?.headers.get('content-type')).toBe('application/octet-stream');
    expect(await feed.download('acme', 'v1.2.3', 'latest.json')).toBeUndefined();
    expect(await feed.download('staff', 'v1.2.3', 'missing.exe')).toBeUndefined();
  });

  it('passes nothing through without a token', async () => {
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      fetch: stubGitHub([release('v1.2.3')]).fetcher,
    });
    expect(await feed.download('staff', 'v1.2.3', 'latest.json')).toBeUndefined();
  });
});

describe('configuration', () => {
  it('offers nothing without a repository', () => {
    expect(desktopUpdateFeed({})).toBeUndefined();
    expect(desktopUpdateFeed({ GITHUB_RELEASES_REPOSITORY: 'not a repository' })).toBeUndefined();
  });

  it('builds download links on the configured address, or the proxy’s', () => {
    const request = new Request(
      'http://localhost:3001/desktop-updates/staff/windows/x86_64/1.0.0',
      {
        headers: { 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' },
      },
    );
    expect(publicOrigin(request, { WEB_APP_URL: 'https://app.integr8.example/' })).toBe(
      'https://app.integr8.example',
    );
    expect(publicOrigin(request, {})).toBe('https://app.example');
  });
});
