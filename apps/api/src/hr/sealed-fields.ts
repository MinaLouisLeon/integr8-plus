import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Employees' sensitive numbers at rest (ADR-0010): AES-256-GCM under
 * `HR_DATA_KEY`, a fresh nonce each time, and the company, the employee and
 * the field bound in as additional data — so a ciphertext copied into another
 * row, another field or another company does not open.
 *
 *   hr1.<nonce base64url>.<ciphertext+tag base64url>
 *
 * **Rotation.** The key that seals is `HR_DATA_KEY`; older keys stay listed in
 * `HR_DATA_KEYS_PREVIOUS` so what they sealed still opens. A value does not
 * say which key sealed it — the stored shape, and the check constraint that
 * pins it (0036), stay as they are, so a rollback reads what it wrote — so
 * opening tries the current key first and then each older one. GCM's tag makes
 * that safe: a wrong key fails authentication, it never returns garbage. Each
 * key is named by its fingerprint ({@link hrKeyId}) in logs and reports, never
 * by its bytes. `admin-cli hr-reseal` re-seals everything still under an older
 * key, after which the older key can be retired.
 */

export const HR_SEALED_PREFIX = 'hr1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export const SEALED_FIELDS = ['nationalId', 'insuranceNumber', 'bankAccount'] as const;
export type SealedFieldName = (typeof SEALED_FIELDS)[number];

export interface SealedContext {
  tenantId: string;
  employeeId: string;
  field: SealedFieldName;
}

function additionalData({ tenantId, employeeId, field }: SealedContext): Buffer {
  return Buffer.from(`${tenantId}:${employeeId}:${field}`, 'utf8');
}

export function hrKey(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

export interface HrKey {
  /** The fingerprint, safe to print: the first twelve characters of its SHA-256. */
  id: string;
  key: Buffer;
}

/** The key that seals, and the older ones that only open. */
export interface HrKeyring {
  current: HrKey;
  previous: readonly HrKey[];
}

/** Names a key without revealing it. */
export function hrKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 12);
}

/** Builds the ring from the configured values (base64, 32 bytes each). */
export function hrKeyring(current: string, previous: readonly string[] = []): HrKeyring {
  const toKey = (value: string): HrKey => {
    const key = hrKey(value);
    return { id: hrKeyId(key), key };
  };
  const now = toKey(current);
  return {
    current: now,
    // The current key listed again among the old ones would only be tried twice.
    previous: previous.map(toKey).filter((old) => old.id !== now.id),
  };
}

/** What opening found: the number, and whether the current key sealed it. */
export interface OpenedField {
  plaintext: string;
  keyId: string;
  current: boolean;
}

/**
 * Opens with the current key, then each older one. Throws when none opens it:
 * sealed under a key this server no longer has, or not for this employee and
 * field.
 */
export function openWithKeyring(
  sealed: string,
  keyring: HrKeyring,
  context: SealedContext,
): OpenedField {
  for (const candidate of [keyring.current, ...keyring.previous]) {
    try {
      return {
        plaintext: openField(sealed, candidate.key, context),
        keyId: candidate.id,
        current: candidate.id === keyring.current.id,
      };
    } catch {
      // The next key; a wrong one fails GCM's authentication check.
    }
  }
  throw new Error('No configured HR key opens this field');
}

export function sealField(plaintext: string, key: Buffer, context: SealedContext): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(context));
  const sealed = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [HR_SEALED_PREFIX, nonce.toString('base64url'), sealed.toString('base64url')].join('.');
}

/** Throws when the value is not this key's ciphertext for this employee and field. */
export function openField(sealed: string, key: Buffer, context: SealedContext): string {
  const [prefix, nonce, payload] = sealed.split('.');
  if (prefix !== HR_SEALED_PREFIX || nonce === undefined || payload === undefined) {
    throw new Error('Not a sealed HR field');
  }
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length <= TAG_BYTES) {
    throw new Error('Sealed HR field is too short');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

/** The last four characters a list may show, spaces and dashes left out. */
export function lastFour(plaintext: string): string {
  return plaintext.replace(/[\s-]/gu, '').slice(-4);
}
