import { describe, expect, it } from 'vitest';
import {
  DesktopUpdateFeed,
  desktopUpdateFeed,
  type GitHubAsset,
  formsAiAssetOf,
  type GitHubRelease,
  hasInstaller,
  installerOf,
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

function asset(tag: string, name: string): GitHubAsset {
  return {
    id: name.length,
    name,
    url: `https://api.github.com/repos/o/r/releases/assets/${name}`,
    browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
    size: 1024,
  };
}

/** A company release as build-company-apps.yml makes it. */
function companyRelease(tag: string, version: string): GitHubRelease {
  const files = [
    `integr8-plus-acme_${version}_x64-setup.exe`,
    `integr8-plus-acme_${version}_x64-setup.exe.sig`,
    `integr8-plus-acme_${version}_x64_en-US.msi`,
    `integr8-plus-acme_${version}_aarch64.dmg`,
    `integr8-plus-acme_${version}_aarch64.app.tar.gz`,
    `integr8-plus-acme_${version}_aarch64.app.tar.gz.sig`,
    `integr8-plus-acme_${version}_amd64.AppImage`,
    `integr8-plus-acme_${version}_amd64.deb`,
    `integr8-plus-acme-${version}-1.x86_64.rpm`,
    `integr8-acme-${version}.apk`,
    'updater-windows-x86_64.json',
    'latest.json',
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: files.map((name) => asset(tag, name)),
  };
}

describe('what the download page lists (Low 6)', () => {
  it('knows an installer by its file name, and nothing else is one', () => {
    expect(installerOf('a_1.0.0_x64-setup.exe')).toEqual({
      platform: 'windows',
      kind: 'exe',
      arch: 'x64',
    });
    expect(installerOf('a_1.0.0_aarch64.dmg')).toEqual({
      platform: 'macos',
      kind: 'dmg',
      arch: 'arm64',
    });
    expect(installerOf('integr8-acme-1.0.0.apk')?.platform).toBe('android');
    for (const name of [
      'a_1.0.0_x64-setup.exe.sig',
      'a_1.0.0_aarch64.app.tar.gz',
      'latest.json',
      'integr8-acme-1.0.0.aab',
    ]) {
      expect(installerOf(name), name).toBeUndefined();
    }
  });

  it('takes a company’s newest release with installers, even one without an update manifest', () => {
    const unsigned: GitHubRelease = {
      ...companyRelease('company-acme-v1.4.0', '1.4.0'),
      assets: [asset('company-acme-v1.4.0', 'integr8-plus-acme_1.4.0_x64-setup.exe')],
    };
    const releases = [companyRelease('company-acme-v1.3.0', '1.3.0'), unsigned];
    expect(newestRelease(releases, 'acme', hasInstaller)?.tag_name).toBe('company-acme-v1.4.0');
    // The updater still needs the manifest.
    expect(newestRelease(releases, 'acme')?.tag_name).toBe('company-acme-v1.3.0');
  });

  it('lists the installers in platform order with GitHub links, for a public repository', async () => {
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      fetch: () => Promise.resolve(Response.json([companyRelease('company-acme-v1.3.0', '1.3.0')])),
    });
    const found = await feed.installers('acme');
    expect(found?.version).toBe('1.3.0');
    expect(found?.installers.map((file) => file.kind)).toEqual([
      'exe',
      'msi',
      'dmg',
      'appimage',
      'deb',
      'rpm',
      'apk',
    ]);
    expect(found?.installers[0]?.url).toBe(
      'https://github.com/o/r/releases/download/company-acme-v1.3.0/integr8-plus-acme_1.3.0_x64-setup.exe',
    );
    expect(found?.installers[0]?.size).toBe(1024);
    expect(await feed.installers('globex')).toBeUndefined();
  });

  it('links a private repository’s files through this server’s download route', async () => {
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      token: 't0ken',
      fetch: () => Promise.resolve(Response.json([companyRelease('company-acme-v1.3.0', '1.3.0')])),
    });
    const found = await feed.installers('acme');
    expect(found?.installers.find((file) => file.kind === 'apk')?.url).toBe(
      '/desktop-updates/acme/download/company-acme-v1.3.0/integr8-acme-1.3.0.apk',
    );
  });
});

/** A staff release with the installer and Integr8 Forms for AI beside it. */
function staffRelease(tag: string, version: string): GitHubRelease {
  const files = [
    `integr8-plus-staff_${version}_x64-setup.exe`,
    `integr8-forms-ai-${version}-windows-x64.exe`,
    `integr8-forms-ai-${version}-windows-x64.exe.sha256`,
    `integr8-forms-ai-${version}-macos-arm64`,
    `integr8-forms-ai-${version}-macos-arm64.sha256`,
    `integr8-forms-ai-${version}-macos-x64`,
    `integr8-forms-ai-${version}-linux-x64`,
    `integr8-forms-ai-${version}-linux-x64.sha256`,
    'latest.json',
  ];
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: files.map((name) => asset(tag, name)),
  };
}

describe('Integr8 Forms for AI on the download page (1.3.0 decision 15)', () => {
  it('knows its builds by name, and they are never the staff app’s installers', () => {
    expect(formsAiAssetOf('integr8-forms-ai-1.3.0-windows-x64.exe')).toEqual({
      platform: 'windows',
      arch: 'x64',
    });
    expect(formsAiAssetOf('integr8-forms-ai-1.3.0-macos-arm64')).toEqual({
      platform: 'macos',
      arch: 'arm64',
    });
    for (const name of [
      'integr8-forms-ai-1.3.0-linux-x64.sha256',
      'integr8-forms-ai-1.3.0-windows-x64',
      'integr8-forms-ai-1.3.0-linux-x64.exe',
      'integr8-plus-staff_1.3.0_x64-setup.exe',
    ]) {
      expect(formsAiAssetOf(name), name).toBeUndefined();
    }
    expect(installerOf('integr8-forms-ai-1.3.0-windows-x64.exe')).toBeUndefined();
  });

  it('lists the newest staff release’s builds, Windows first, apart from the installers', async () => {
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      fetch: () =>
        Promise.resolve(
          Response.json([staffRelease('v1.2.4', '1.2.4'), staffRelease('v1.3.0', '1.3.0')]),
        ),
    });
    const found = await feed.formsAi();
    expect(found?.version).toBe('1.3.0');
    expect(found?.downloads.map((file) => `${file.platform}-${file.arch}`)).toEqual([
      'windows-x64',
      'macos-arm64',
      'macos-x64',
      'linux-x64',
    ]);
    expect(found?.downloads[0]?.url).toBe(
      'https://github.com/o/r/releases/download/v1.3.0/integr8-forms-ai-1.3.0-windows-x64.exe',
    );
    const staff = await feed.installers('staff');
    expect(staff?.installers.map((file) => file.name)).toEqual([
      'integr8-plus-staff_1.3.0_x64-setup.exe',
    ]);
  });

  it('links through this server for a private repository, and offers nothing before a release has it', async () => {
    const feed = new DesktopUpdateFeed({
      repository: 'o/r',
      token: 't0ken',
      fetch: () => Promise.resolve(Response.json([staffRelease('v1.3.0', '1.3.0')])),
    });
    expect((await feed.formsAi())?.downloads[0]?.url).toBe(
      '/desktop-updates/staff/download/v1.3.0/integr8-forms-ai-1.3.0-windows-x64.exe',
    );
    const older = new DesktopUpdateFeed({
      repository: 'o/r',
      fetch: () => Promise.resolve(Response.json([release('v1.2.4')])),
    });
    expect(await older.formsAi()).toBeUndefined();
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
