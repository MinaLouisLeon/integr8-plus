/**
 * The desktop apps' update feed (P20), served at `/desktop-updates/…`.
 *
 * Every desktop build asks its own address, stamped in at build time
 * (`apps/desktop/scripts/stamp.mjs`): `/desktop-updates/staff/…` for the staff
 * app, `/desktop-updates/<company slug>/…` for a company's. The answer is the
 * `latest.json` attached to that app's newest GitHub release (`vX.Y.Z` for
 * staff, `company-<slug>-vX.Y.Z` for a company), which names each platform's
 * signed download. The app checks that signature against the public key it
 * carries, so this feed decides what is offered but cannot make an app install
 * something the release key did not sign.
 *
 * GitHub is asked at most once per cache window for the list of releases
 * (unauthenticated, that is 60 requests an hour for the whole server), and
 * each release's manifest is read once. A token is needed only if the
 * repository becomes private: then GitHub's download links need it too, so
 * the manifest's links are pointed back here and the files are passed through.
 *
 * The same list feeds the public `/download` page (Low 6): an app's newest
 * release with installers in it, each file linked the way the updater's are
 * (straight to GitHub, or through this server for a private repository).
 */

export interface GitHubAsset {
  id: number;
  name: string;
  /** The API address of the asset; with `accept: application/octet-stream` it is the file. */
  url: string;
  browser_download_url: string;
  /** Bytes. GitHub always sends it; optional so a test release can leave it out. */
  size?: number;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

/** What Tauri's updater reads: a version and one signed download per platform. */
export interface UpdateManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { url: string; signature: string }>;
}

export interface DesktopUpdateFeedOptions {
  /** `owner/name` of the repository whose releases hold the apps. */
  repository: string;
  /** Only needed while the repository is private. */
  token?: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

const MANIFEST = 'latest.json';
/** The staff app, or a company's short name (the slug rule companies are created with). */
const APP = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u;
const SEMVER = String.raw`v(\d+)\.(\d+)\.(\d+)`;
/** Releases looked through, newest first: enough for many companies and nightlies. */
const PAGES = 3;

export function isAppName(app: string): boolean {
  return APP.test(app);
}

/** The tags that belong to one app: `vX.Y.Z` for staff, `company-<slug>-vX.Y.Z` for a company. */
export function tagPattern(app: string): RegExp {
  if (!isAppName(app)) {
    throw new Error(`Not an app name: ${app}`);
  }
  return app === 'staff'
    ? new RegExp(`^${SEMVER}$`, 'u')
    : new RegExp(`^company-${app}-${SEMVER}$`, 'u');
}

/** A release the updater can use: it carries the update manifest. */
export function hasManifest(release: GitHubRelease): boolean {
  return release.assets.some((asset) => asset.name === MANIFEST);
}

/** A release somebody can install from: it carries at least one installer. */
export function hasInstaller(release: GitHubRelease): boolean {
  return release.assets.some((asset) => installerOf(asset.name) !== undefined);
}

/**
 * The newest published release of one app, by version, among those `accept`
 * takes: by default the ones with an update manifest, which is what the
 * updater needs.
 */
export function newestRelease(
  releases: readonly GitHubRelease[],
  app: string,
  accept: (release: GitHubRelease) => boolean = hasManifest,
): GitHubRelease | undefined {
  const pattern = tagPattern(app);
  let best: { release: GitHubRelease; parts: number[] } | undefined;
  for (const release of releases) {
    const match = pattern.exec(release.tag_name);
    if (match === null || release.draft || release.prerelease) continue;
    if (!accept(release)) continue;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (best === undefined || compare(parts, best.parts) > 0) {
      best = { release, parts };
    }
  }
  return best?.release;
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export type InstallerPlatform = 'windows' | 'macos' | 'linux' | 'android';
export type InstallerKind = 'exe' | 'msi' | 'dmg' | 'appimage' | 'deb' | 'rpm' | 'apk';
export type InstallerArch = 'x64' | 'arm64' | 'universal';

/** One file a person can install, as the download page lists it. */
export interface Installer {
  name: string;
  /** Straight to GitHub for a public repository, through this server for a private one. */
  url: string;
  platform: InstallerPlatform;
  kind: InstallerKind;
  arch: InstallerArch | null;
  size: number | null;
}

/** An app's newest installable release. */
export interface AppRelease {
  tag: string;
  version: string;
  installers: Installer[];
}

const INSTALLER_KINDS: readonly {
  test: RegExp;
  platform: InstallerPlatform;
  kind: InstallerKind;
}[] = [
  { test: /\.exe$/iu, platform: 'windows', kind: 'exe' },
  { test: /\.msi$/iu, platform: 'windows', kind: 'msi' },
  { test: /\.dmg$/iu, platform: 'macos', kind: 'dmg' },
  { test: /\.appimage$/iu, platform: 'linux', kind: 'appimage' },
  { test: /\.deb$/iu, platform: 'linux', kind: 'deb' },
  { test: /\.rpm$/iu, platform: 'linux', kind: 'rpm' },
  // The Android app a phone installs from the link. A store bundle (.aab)
  // is not listed: no phone can install one.
  { test: /\.apk$/iu, platform: 'android', kind: 'apk' },
];

/**
 * What kind of installer a release file is, or undefined for everything
 * else: signatures, manifests, and macOS's update archive (`.app.tar.gz`),
 * which only the updater uses.
 */
export function installerOf(
  name: string,
): { platform: InstallerPlatform; kind: InstallerKind; arch: InstallerArch | null } | undefined {
  const found = INSTALLER_KINDS.find((entry) => entry.test.test(name));
  if (found === undefined) {
    return undefined;
  }
  const arch = /universal/iu.test(name)
    ? 'universal'
    : /(aarch64|arm64)/iu.test(name)
      ? 'arm64'
      : /(x64|x86_64|amd64)/iu.test(name)
        ? 'x64'
        : null;
  return { platform: found.platform, kind: found.kind, arch };
}

const PLATFORM_ORDER: readonly InstallerPlatform[] = ['windows', 'macos', 'linux', 'android'];

/** Within a platform, the installer most people want first (the setup .exe before the .msi). */
function kindOrder(kind: InstallerKind): number {
  return INSTALLER_KINDS.findIndex((entry) => entry.kind === kind);
}

/**
 * The installers of one release, in the order the page shows them, each
 * linked straight to GitHub or, with `proxyBase` (a private repository),
 * through this server's `/desktop-updates/<app>/download/<tag>/<file>`.
 */
export function releaseInstallers(
  release: GitHubRelease,
  options: { app: string; proxyBase?: string | undefined },
): AppRelease {
  const installers: Installer[] = [];
  for (const asset of release.assets) {
    const kind = installerOf(asset.name);
    if (kind === undefined) continue;
    installers.push({
      name: asset.name,
      url:
        options.proxyBase === undefined
          ? asset.browser_download_url
          : `${options.proxyBase.replace(/\/+$/u, '')}/desktop-updates/${options.app}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
      ...kind,
      size: typeof asset.size === 'number' ? asset.size : null,
    });
  }
  installers.sort(
    (a, b) =>
      PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) ||
      kindOrder(a.kind) - kindOrder(b.kind) ||
      a.name.localeCompare(b.name),
  );
  const version = /v(\d+\.\d+\.\d+)$/u.exec(release.tag_name)?.[1] ?? release.tag_name;
  return { tag: release.tag_name, version, installers };
}

/**
 * Points every download in a manifest at this server, for a private
 * repository, whose GitHub links an installed app could not open.
 */
export function proxiedManifest(
  manifest: UpdateManifest,
  options: { app: string; tag: string; origin: string },
): UpdateManifest {
  const platforms: UpdateManifest['platforms'] = {};
  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const file = decodeURIComponent(entry.url.split('/').pop() ?? '');
    platforms[key] = {
      ...entry,
      url: `${options.origin.replace(/\/+$/u, '')}/desktop-updates/${options.app}/download/${encodeURIComponent(options.tag)}/${encodeURIComponent(file)}`,
    };
  }
  return { ...manifest, platforms };
}

interface Cached<T> {
  at: number;
  value: T;
}

export class DesktopUpdateFeed {
  readonly #repository: string;
  readonly #token: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #ttl: number;
  #releases: Cached<Promise<GitHubRelease[]>> | undefined;
  readonly #manifests = new Map<string, UpdateManifest>();

  constructor(options: DesktopUpdateFeedOptions) {
    this.#repository = options.repository;
    this.#token = options.token === '' ? undefined : options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 5 * 60 * 1000;
  }

  /**
   * The manifest for one app, or `undefined` when it has no release with one
   * (then there is no update, which the updater reads from a 204).
   */
  async manifest(app: string, origin: string): Promise<UpdateManifest | undefined> {
    const release = newestRelease(await this.#listReleases(), app);
    if (release === undefined) {
      return undefined;
    }
    const manifest = await this.#readManifest(release);
    return this.#token === undefined
      ? manifest
      : proxiedManifest(manifest, { app, tag: release.tag_name, origin });
  }

  /**
   * The app's newest release that has installers in it, for the download
   * page, or `undefined` when there is none. Links to a private repository's
   * files go through this server, relative to it unless `origin` is given.
   */
  async installers(app: string, origin = ''): Promise<AppRelease | undefined> {
    const release = newestRelease(await this.#listReleases(), app, hasInstaller);
    if (release === undefined) {
      return undefined;
    }
    return releaseInstallers(release, {
      app,
      proxyBase: this.#token === undefined ? undefined : origin,
    });
  }

  /**
   * One file of one of the app's releases, passed through with the token
   * (a private repository only). `undefined` for anything that is not an
   * asset of a release belonging to that app.
   */
  async download(app: string, tag: string, file: string): Promise<Response | undefined> {
    if (this.#token === undefined || !tagPattern(app).test(tag)) {
      return undefined;
    }
    const asset = (await this.#listReleases())
      .find((release) => release.tag_name === tag)
      ?.assets.find((candidate) => candidate.name === file);
    if (asset === undefined) {
      return undefined;
    }
    const upstream = await this.#fetch(asset.url, {
      headers: { ...this.#headers(), accept: 'application/octet-stream' },
    });
    if (!upstream.ok || upstream.body === null) {
      throw new Error(`GitHub answered ${String(upstream.status)} for ${tag}/${file}`);
    }
    const headers = new Headers({
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'private, max-age=3600',
    });
    const length = upstream.headers.get('content-length');
    if (length !== null) headers.set('content-length', length);
    return new Response(upstream.body, { status: 200, headers });
  }

  #headers(): Record<string, string> {
    return {
      'user-agent': 'integr8-plus-web',
      'x-github-api-version': '2022-11-28',
      ...(this.#token === undefined ? {} : { authorization: `Bearer ${this.#token}` }),
    };
  }

  /**
   * The releases, newest first, from the cache while it is fresh. Concurrent
   * requests share one fetch; when GitHub cannot be reached, the last list
   * is used rather than nothing.
   */
  async #listReleases(): Promise<GitHubRelease[]> {
    const now = this.#now();
    const cached = this.#releases;
    if (cached !== undefined && now - cached.at < this.#ttl) {
      return cached.value;
    }
    const pending = this.#fetchReleases();
    this.#releases = { at: now, value: pending };
    try {
      return await pending;
    } catch (error) {
      if (cached === undefined) {
        this.#releases = undefined;
        throw error;
      }
      this.#releases = cached;
      return cached.value;
    }
  }

  async #fetchReleases(): Promise<GitHubRelease[]> {
    const releases: GitHubRelease[] = [];
    for (let page = 1; page <= PAGES; page += 1) {
      const response = await this.#fetch(
        `https://api.github.com/repos/${this.#repository}/releases?per_page=100&page=${String(page)}`,
        { headers: { ...this.#headers(), accept: 'application/vnd.github+json' } },
      );
      if (!response.ok) {
        throw new Error(`GitHub answered ${String(response.status)} listing releases`);
      }
      const batch = (await response.json()) as GitHubRelease[];
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    return releases;
  }

  /**
   * A release's manifest. Kept for good once read: a release's files never
   * change after it is published (a new version is a new release), so the
   * list of releases is the only thing that goes stale.
   */
  async #readManifest(release: GitHubRelease): Promise<UpdateManifest> {
    const cached = this.#manifests.get(release.tag_name);
    if (cached !== undefined) {
      return cached;
    }
    const asset = release.assets.find((candidate) => candidate.name === MANIFEST);
    if (asset === undefined) {
      throw new Error(`${release.tag_name} has no ${MANIFEST}`);
    }
    const response =
      this.#token === undefined
        ? await this.#fetch(asset.browser_download_url, { headers: this.#headers() })
        : await this.#fetch(asset.url, {
            headers: { ...this.#headers(), accept: 'application/octet-stream' },
          });
    if (!response.ok) {
      throw new Error(
        `GitHub answered ${String(response.status)} for ${release.tag_name}/${MANIFEST}`,
      );
    }
    const value = (await response.json()) as UpdateManifest;
    if (this.#manifests.size >= 500) {
      this.#manifests.clear();
    }
    this.#manifests.set(release.tag_name, value);
    return value;
  }
}

let shared: DesktopUpdateFeed | undefined;

/**
 * The server's feed, from its environment: `GITHUB_RELEASES_REPOSITORY`
 * (`owner/name`) and, only for a private repository, `GITHUB_RELEASES_TOKEN`
 * (fine-grained, Contents: read on that repository). Without a repository
 * the feed offers no updates.
 */
export function desktopUpdateFeed(
  env: Record<string, string | undefined> = process.env,
): DesktopUpdateFeed | undefined {
  const repository = env.GITHUB_RELEASES_REPOSITORY?.trim() ?? '';
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    return undefined;
  }
  shared ??= new DesktopUpdateFeed({ repository, token: env.GITHUB_RELEASES_TOKEN?.trim() });
  return shared;
}

/**
 * Where this server is reached from outside, for the links in a proxied
 * manifest: `WEB_APP_URL` when set, otherwise what the reverse proxy says.
 */
export function publicOrigin(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.WEB_APP_URL?.trim() ?? '';
  if (configured !== '') {
    return new URL(configured).origin;
  }
  const url = new URL(request.url);
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host;
  const proto = request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '');
  return `${proto}://${host}`;
}
