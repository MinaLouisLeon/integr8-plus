import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Employees' sensitive numbers at rest (ADR-0010): AES-256-GCM under
 * `HR_DATA_KEY`, a fresh nonce each time, and the company, the employee and
 * the field bound in as additional data — so a ciphertext copied into another
 * row, another field or another company does not open.
 *
 *   hr1.<nonce base64url>.<ciphertext+tag base64url>
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
