/**
 * What the desktop updater reads, and the release assets it points at.
 *
 * Tauri's updater asks the feed (the web app's `/desktop-updates/<app>/…`,
 * which reads a release's `latest.json`) for a manifest naming, per platform,
 * a download and its signature:
 *
 *   { "version": "1.2.3", "pub_date": "…", "notes": "…",
 *     "platforms": { "windows-x86_64-nsis": { "url": "…", "signature": "…" }, … } }
 *
 * The plugin looks for `{os}-{arch}-{installer}` first (the way the app was
 * installed: nsis, msi, appimage, deb, rpm, app) and then `{os}-{arch}`, so
 * both are written. Each build machine knows only its own platform, so it
 * writes a fragment beside its installers (`collect-bundles.mjs`); the release
 * job merges the fragments into one `latest.json` (`updater-manifest.mjs`).
 *
 * The installers are renamed on the way: GitHub rewrites an asset name with
 * spaces or anything outside ASCII (a company's name may be Arabic), and the
 * manifest has to name the asset exactly as GitHub stores it.
 */

/** The fragment files a build machine leaves for the release job. */
export const FRAGMENT_PATTERN = /^updater-[a-z]+-[a-z0-9_]+\.json$/u;

/** Which installer a bundle is, by its file name, as the updater names it. */
export function installerKind(fileName) {
  if (fileName.endsWith('.app.tar.gz')) return 'app';
  if (/\.exe$/iu.test(fileName)) return 'nsis';
  if (/\.msi$/iu.test(fileName)) return 'msi';
  if (fileName.endsWith('.AppImage')) return 'appimage';
  if (fileName.endsWith('.deb')) return 'deb';
  if (fileName.endsWith('.rpm')) return 'rpm';
  return undefined;
}

/** Node's names for the operating system, as the updater spells them. */
export function updaterOs(platform) {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  if (os === undefined) throw new Error(`No updater name for platform ${platform}`);
  return os;
}

/** Node's names for the processor, as the updater spells them. */
export function updaterArch(arch) {
  const name = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686', arm: 'armv7' }[arch];
  if (name === undefined) throw new Error(`No updater name for architecture ${arch}`);
  return name;
}

/**
 * The installer used when the manifest has no entry for the way the app was
 * installed (an older updater plugin asks only for `{os}-{arch}`). Windows
 * prefers the NSIS setup, which updates in place and starts the app again.
 */
const GENERIC_PREFERENCE = {
  windows: ['nsis', 'msi'],
  darwin: ['app'],
  linux: ['appimage', 'deb', 'rpm'],
};

/**
 * A name GitHub keeps as it is: the product name (which may hold spaces or
 * Arabic) replaced by a plain prefix. macOS's update archive carries no
 * version or architecture of its own, so both are added.
 */
export function assetName({ fileName, productName, prefix, version, arch }) {
  let rest = fileName;
  if (fileName.startsWith(`${productName}.`)) {
    rest = `${version}_${arch}${fileName.slice(productName.length)}`;
  } else if (fileName.startsWith(`${productName}_`) || fileName.startsWith(`${productName}-`)) {
    rest = fileName.slice(productName.length + 1);
  }
  return `${prefix}_${rest}`.replace(/[^A-Za-z0-9._-]+/gu, '-');
}

/**
 * The renamed files and this platform's manifest fragment, from the list of
 * files Tauri produced. A bundle is an update only when its `.sig` is beside
 * it, which happens when the build had the updater signing key.
 *
 * @param {{ files: string[]; productName: string; prefix: string; version: string;
 *   os: string; arch: string; readSignature: (file: string) => string }} input
 */
export function planCollection({ files, productName, prefix, version, os, arch, readSignature }) {
  const baseName = (file) => file.split(/[\\/]/u).pop() ?? file;
  const present = new Set(files);
  const copies = files.map((from) => ({
    from,
    to: assetName({ fileName: baseName(from), productName, prefix, version, arch }),
  }));

  /** @type {Record<string, { asset: string; signature: string }>} */
  const platforms = {};
  for (const copy of copies) {
    const kind = installerKind(copy.to);
    if (kind === undefined || !present.has(`${copy.from}.sig`)) continue;
    platforms[`${os}-${arch}-${kind}`] = {
      asset: copy.to,
      signature: readSignature(`${copy.from}.sig`).trim(),
    };
  }
  for (const kind of GENERIC_PREFERENCE[os] ?? []) {
    const chosen = platforms[`${os}-${arch}-${kind}`];
    if (chosen !== undefined) {
      platforms[`${os}-${arch}`] = chosen;
      break;
    }
  }

  const fragment =
    Object.keys(platforms).length === 0
      ? undefined
      : { name: `updater-${os}-${arch}.json`, content: { platforms } };
  return { copies, fragment };
}

/**
 * One `latest.json` from every build machine's fragment, with each asset's
 * download address under `downloadBase` (the release's download folder).
 *
 * @param {{ fragments: { platforms: Record<string, { asset: string; signature: string }> }[];
 *   version: string; notes: string; pubDate: string; downloadBase: string }} input
 */
export function buildManifest({ fragments, version, notes, pubDate, downloadBase }) {
  const base = downloadBase.replace(/\/+$/u, '');
  /** @type {Record<string, { url: string; signature: string }>} */
  const platforms = {};
  for (const fragment of fragments) {
    for (const [key, entry] of Object.entries(fragment.platforms)) {
      platforms[key] = {
        url: `${base}/${encodeURIComponent(entry.asset)}`,
        signature: entry.signature,
      };
    }
  }
  return { version, notes, pub_date: pubDate, platforms };
}
