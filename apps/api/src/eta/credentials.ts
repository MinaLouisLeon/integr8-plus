import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * A company's ETA client id and secret at rest (ADR-0014 D4): AES-256-GCM
 * under `ETA_CREDENTIALS_KEY`, a fresh nonce each time, and the company and
 * the field bound in as additional data — so a ciphertext copied into another
 * company, or from the id column to the secret column, does not open.
 *
 *   eta1.<nonce base64url>.<ciphertext+tag base64url>
 *
 * Opened only on the server, only to ask the ETA for a token, and never
 * returned to any client or written to a log.
 */

export const ETA_SEALED_PREFIX = 'eta1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type EtaCredentialField = 'clientId' | 'clientSecret';

function additionalData(tenantId: string, field: EtaCredentialField): Buffer {
  return Buffer.from(`eta:${tenantId}:${field}`, 'utf8');
}

export function etaKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('ETA_CREDENTIALS_KEY must be 32 bytes');
  }
  return key;
}

export function sealCredential(
  plaintext: string,
  key: Buffer,
  tenantId: string,
  field: EtaCredentialField,
): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(tenantId, field));
  const sealed = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return [ETA_SEALED_PREFIX, nonce.toString('base64url'), sealed.toString('base64url')].join('.');
}

/** Throws when the value is not this key's ciphertext for this company and field. */
export function openCredential(
  sealed: string,
  key: Buffer,
  tenantId: string,
  field: EtaCredentialField,
): string {
  const [prefix, nonce, payload, extra] = sealed.split('.');
  if (prefix !== ETA_SEALED_PREFIX || nonce === undefined || payload === undefined || extra) {
    throw new Error('Not a sealed ETA credential');
  }
  const bytes = Buffer.from(payload, 'base64url');
  if (bytes.length <= TAG_BYTES) {
    throw new Error('Sealed ETA credential is too short');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  decipher.setAAD(additionalData(tenantId, field));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

/** What a screen may show of a client id: its last four characters. */
export function credentialHint(clientId: string): string {
  return clientId.trim().slice(-4);
}
