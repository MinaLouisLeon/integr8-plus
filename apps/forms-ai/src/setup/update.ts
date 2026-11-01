import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { Host } from '../host.js';
import { PROGRAM_NAME } from '../version.js';

/**
 * The installer's update check: is there a newer release of the app on
 * GitHub with this tool built for this computer? The tool ships with the app
 * (decision 15), so its releases are the app's `vX.Y.Z` releases, and the
 * assets are named by `assetName`. The repository is public; the check is
 * one unauthenticated request with a short timeout, silent when offline, and
 * nothing is downloaded or replaced unless the person says yes.
 */

export const DEFAULT_REPOSITORY = 'MinaLouisLeon/integr8-plus';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

export interface AvailableUpdate {
  version: string;
  tag: string;
  asset: ReleaseAsset;
  checksum: ReleaseAsset;
}

/** `windows`, `macos` or `linux`, as the release names them. */
export function osName(platform: NodeJS.Platform): 'windows' | 'macos' | 'linux' | undefined {
  return platform === 'win32'
    ? 'windows'
    : platform === 'darwin'
      ? 'macos'
      : platform === 'linux'
        ? 'linux'
        : undefined;
}

/** `integr8-forms-ai-1.3.0-windows-x64.exe`, `integr8-forms-ai-1.3.0-macos-arm64`, … */
export function assetName(
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const os = osName(platform);
  if (os === undefined || (arch !== 'x64' && arch !== 'arm64')) {
    return undefined;
  }
  return `${PROGRAM_NAME}-${version}-${os}-${arch}${platform === 'win32' ? '.exe' : ''}`;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/u;

/** Compares two plain versions; anything else (a nightly) sorts below every release. */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (left === null || right === null) {
    return left === null ? (right === null ? 0 : -1) : 1;
  }
  for (let i = 1; i <= 3; i += 1) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** The newest release newer than `current` that has this computer's file and its checksum. */
export function findUpdate(
  releases: readonly Release[],
  current: string,
  platform: NodeJS.Platform,
  arch: string,
): AvailableUpdate | undefined {
  let best: AvailableUpdate | undefined;
  for (const release of releases) {
    const match = SEMVER.exec(release.tag_name);
    if (match === null || release.draft || release.prerelease) {
      continue;
    }
    const version = `${match[1] ?? ''}.${match[2] ?? ''}.${match[3] ?? ''}`;
    if (compareVersions(version, current) <= 0) {
      continue;
    }
    const name = assetName(version, platform, arch);
    const asset = release.assets.find((candidate) => candidate.name === name);
    const checksum = release.assets.find((candidate) => candidate.name === `${name ?? ''}.sha256`);
    if (asset === undefined || checksum === undefined) {
      continue;
    }
    if (best === undefined || compareVersions(version, best.version) > 0) {
      best = { version, tag: release.tag_name, asset, checksum };
    }
  }
  return best;
}

export function repositoryOf(host: Host): string {
  const named = host.env.INTEGR8_FORMS_REPOSITORY?.trim() ?? '';
  return /^[\w.-]+\/[\w.-]+$/u.test(named) ? named : DEFAULT_REPOSITORY;
}

const HEADERS = { 'user-agent': PROGRAM_NAME, accept: 'application/vnd.github+json' };

/** Asks GitHub; undefined when offline, slow, rate-limited or switched off. */
export async function checkForUpdate(
  host: Host,
  current: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<AvailableUpdate | undefined> {
  // A nightly build is not offered releases: it would be offered older code.
  if (host.env.INTEGR8_FORMS_NO_UPDATE_CHECK === '1' || !SEMVER.test(current)) {
    return undefined;
  }
  try {
    const response = await (options.fetch ?? fetch)(
      `https://api.github.com/repos/${repositoryOf(host)}/releases?per_page=30`,
      { headers: HEADERS, signal: AbortSignal.timeout(options.timeoutMs ?? 3000) },
    );
    if (!response.ok) {
      return undefined;
    }
    return findUpdate((await response.json()) as Release[], current, host.platform, host.arch);
  } catch {
    return undefined;
  }
}

/** The hash in a `.sha256` file: `<hex>  <name>` or just `<hex>`. */
export function parseChecksum(text: string): string | undefined {
  return /\b([0-9a-f]{64})\b/iu.exec(text)?.[1]?.toLowerCase();
}

/**
 * Downloads the update, checks it against its published SHA-256, and puts it
 * at `target` (the installed program's own path), so every AI tool's
 * configuration keeps working. The running file is moved aside rather than
 * overwritten: Windows will not overwrite a program that is running, but it
 * will rename one. The old copy is deleted on the next start.
 */
export async function applyUpdate(
  update: AvailableUpdate,
  target: string,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const get = options.fetch ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10 * 60 * 1000);
  const sums = await get(update.checksum.browser_download_url, {
    headers: { 'user-agent': PROGRAM_NAME },
    signal,
  });
  if (!sums.ok) {
    throw new Error(`GitHub answered ${String(sums.status)} for the checksum.`);
  }
  const expected = parseChecksum(await sums.text());
  if (expected === undefined) {
    throw new Error('The published checksum could not be read.');
  }
  const response = await get(update.asset.browser_download_url, {
    headers: { 'user-agent': PROGRAM_NAME },
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${String(response.status)} for the download.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Error('The download does not match its published checksum; nothing was changed.');
  }
  replaceProgram(target, bytes);
}

/** Puts new program bytes at `target`, moving a running copy aside first. */
export function replaceProgram(target: string, bytes: Uint8Array): void {
  const incoming = `${target}.new`;
  const old = `${target}.old`;
  writeFileSync(incoming, bytes);
  chmodSync(incoming, 0o755);
  rmSync(old, { force: true });
  if (existsSync(target)) {
    renameSync(target, old);
  }
  try {
    renameSync(incoming, target);
  } catch (error) {
    if (existsSync(old) && !existsSync(target)) {
      renameSync(old, target);
    }
    throw error;
  }
  // Where the old copy is not running (everywhere but Windows), it goes now.
  try {
    rmSync(old, { force: true });
  } catch {
    // A running copy on Windows is removed on the next start.
  }
}

/** Removes what an earlier update left behind. */
export function cleanUpAfterUpdate(target: string): void {
  for (const leftover of [`${target}.old`, `${target}.new`]) {
    try {
      rmSync(leftover, { force: true });
    } catch {
      // Still running; next time.
    }
  }
}
