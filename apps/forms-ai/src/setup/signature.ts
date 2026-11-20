import { createPublicKey, verify } from 'node:crypto';

/**
 * Who made an update (SEC-004).
 *
 * A file's `.sha256` sits in the same GitHub release as the file, so it
 * proves the download was not damaged, not who published it: anybody able to
 * publish a release could ship a program and a matching checksum. So each
 * release also carries `integr8-update-manifest.json`, the name and SHA-256 of
 * every file in it, and `integr8-update-manifest.json.sig`, an Ed25519
 * signature over the manifest's exact bytes made with Integr8's own update key
 * (`UPDATE_SIGNING_KEY`, kept in the `release` GitHub environment and nowhere
 * else; `scripts/releases/sign-updates.mjs`). Forms for AI and the developer
 * program replace themselves only with a file whose hash a manifest signed by
 * one of the keys below names, for exactly the version offered. No Microsoft
 * or Apple certificate is involved: the key is ours and free.
 *
 * To rotate the key: add the new public key here, release, and only then sign
 * with the new private key; remove the old public key a release later.
 */

/** The manifest's file name in a release. */
export const UPDATE_MANIFEST = 'integr8-update-manifest.json';
/** Its signature's file name in the same release. */
export const UPDATE_SIGNATURE = `${UPDATE_MANIFEST}.sig`;

/** Integr8's update keys: raw Ed25519 public keys, base64. */
export const UPDATE_PUBLIC_KEYS: readonly string[] = [
  // 2026-11-16, generated for SEC-004; its private half is UPDATE_SIGNING_KEY.
  'HDJkPg5NqK8I+KLCimeTxWhk6VdIlj3TZ0GhuI1yJgw=',
];

export interface UpdateManifest {
  format: 1;
  /** The release, `X.Y.Z`. */
  version: string;
  /** Every signed file of the release: its name and lowercase hex SHA-256. */
  files: Record<string, string>;
}

/** The SPKI prefix that turns a raw 32-byte Ed25519 key into a key Node can read. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyOf(raw: string) {
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) {
    throw new Error('An update key is not a 32-byte Ed25519 key.');
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]),
    format: 'der',
    type: 'spki',
  });
}

/**
 * The manifest, once its signature is proven to come from one of `keys`.
 * Throws, saying why, for a missing or wrong signature or a manifest that is
 * not the expected shape: nothing is to be replaced then.
 */
export function verifiedManifest(
  manifestBytes: Uint8Array,
  signatureText: string,
  keys: readonly string[] = UPDATE_PUBLIC_KEYS,
): UpdateManifest {
  const signature = Buffer.from(signatureText.trim(), 'base64');
  if (signature.length !== 64) {
    throw new Error('The update has no valid signature; nothing was changed.');
  }
  const signed = keys.some((key) => verify(null, manifestBytes, publicKeyOf(key), signature));
  if (!signed) {
    throw new Error('The update is not signed by Integr8; nothing was changed.');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
  } catch {
    throw new Error('The signed update list could not be read; nothing was changed.');
  }
  const candidate = manifest as Partial<UpdateManifest> | null;
  if (
    candidate?.format !== 1 ||
    typeof candidate.version !== 'string' ||
    typeof candidate.files !== 'object' ||
    candidate.files === null
  ) {
    throw new Error('The signed update list is not one this program knows; nothing was changed.');
  }
  return candidate as UpdateManifest;
}

/**
 * The SHA-256 the signed manifest gives `file` in release `version`. Throws
 * when the manifest is for another release (an old signed list replayed) or
 * does not name the file.
 */
export function signedHashOf(manifest: UpdateManifest, version: string, file: string): string {
  if (manifest.version !== version) {
    throw new Error(
      `The signed update list is for ${manifest.version}, not ${version}; nothing was changed.`,
    );
  }
  const hash = manifest.files[file];
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/u.test(hash)) {
    throw new Error(`${file} is not in the signed update list; nothing was changed.`);
  }
  return hash;
}
