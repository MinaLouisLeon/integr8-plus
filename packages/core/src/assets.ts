import { z } from 'zod';

/**
 * Assets: the machines a company services, their tags and their history
 * (CRM/ERP plan, phase E3; ADR-0008). The vocabulary here is checked against
 * the database's own check constraints by the schema-invariant suite.
 */

export const ASSET_STATUSES = ['active', 'out_of_service', 'retired'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

/** The last condition someone recorded, worst last. */
export const ASSET_CONDITIONS = ['good', 'fair', 'poor', 'unusable'] as const;
export const assetConditionSchema = z.enum(ASSET_CONDITIONS);
export type AssetCondition = z.infer<typeof assetConditionSchema>;

/** What an asset event records. An asset's history is these, plus its jobs. */
export const ASSET_EVENT_KINDS = [
  'registered',
  'updated',
  'relocated',
  'status_changed',
  'condition_recorded',
  'tag_reissued',
] as const;
export const assetEventKindSchema = z.enum(ASSET_EVENT_KINDS);
export type AssetEventKind = z.infer<typeof assetEventKindSchema>;

/** `AS-000123`. */
export function formatAssetReference(reference: number): string {
  return `AS-${String(reference).padStart(6, '0')}`;
}

/** `AS-000123`, `as123` or `123` → 123; anything else → undefined. */
export function parseAssetReference(text: string): number | undefined {
  const match = /^\s*(?:as-?)?0*(\d{1,9})\s*$/iu.exec(text);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Twelve characters: 60 random bits. */
export const TAG_CODE_LENGTH = 12;

export const tagCodeSchema = z
  .string()
  .length(TAG_CODE_LENGTH)
  .regex(/^[0-9A-HJKMNP-TV-Z]+$/u);

/** A fresh tag code from a cryptographic source. */
export function newTagCode(
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) =>
    globalThis.crypto.getRandomValues(bytes),
): string {
  const bytes = random(new Uint8Array(TAG_CODE_LENGTH));
  let code = '';
  for (const byte of bytes) {
    code += CROCKFORD[byte & 31];
  }
  return code;
}

/**
 * A code as typed or read: case folded, separators dropped, and the letters
 * Crockford's alphabet leaves out read as the digits they look like.
 */
export function normalizeTagCode(text: string): string | undefined {
  const folded = text
    .toUpperCase()
    .replace(/[\s-]/gu, '')
    .replace(/O/gu, '0')
    .replace(/[IL]/gu, '1');
  return tagCodeSchema.safeParse(folded).success ? folded : undefined;
}

/** What the printed QR code holds: a link into the web app. */
export function assetTagLink(webAppUrl: string, code: string): string {
  return `${webAppUrl.replace(/\/+$/u, '')}/a/${code}`;
}

/**
 * The tag code in what a camera read: a tag link from any host (a company's
 * own domain included), or a bare code. Anything else → undefined.
 */
export function tagCodeOf(scanned: string): string | undefined {
  const text = scanned.trim();
  const link = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(?:\/[^?#]*)?\/a\/([^/?#]+)\/?(?:[?#].*)?$/iu.exec(
    text,
  );
  return normalizeTagCode(link === null ? text : decodeURIComponent(link[1]!));
}

// ---------------------------------------------------------------------------
// Warranty
// ---------------------------------------------------------------------------

export const WARRANTY_STATES = ['none', 'covered', 'expiring', 'expired'] as const;
export type WarrantyState = (typeof WARRANTY_STATES)[number];

/** How far ahead a company is warned by default, in days. */
export const DEFAULT_WARRANTY_ALERT_DAYS = 60;
export const warrantyAlertDaysSchema = z.number().int().min(0).max(365);

/**
 * Where a warranty stands on `today` (both `YYYY-MM-DD` in the company's
 * calendar): none recorded, covered, ending within `alertDays`, or ended. The
 * last covered day is the expiry date itself.
 */
export function warrantyState(
  expiresOn: string | null,
  today: string,
  alertDays: number,
): WarrantyState {
  if (expiresOn === null) {
    return 'none';
  }
  if (expiresOn < today) {
    return 'expired';
  }
  const horizon = new Date(`${today}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + alertDays);
  return expiresOn <= horizon.toISOString().slice(0, 10) ? 'expiring' : 'covered';
}
