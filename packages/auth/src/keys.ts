import { exportJWK, generateKeyPair, importJWK, type JWK } from 'jose';
import { z } from 'zod';
import type { AuthConfig } from './config.js';

/**
 * Signing and verification keys.
 *
 * One algorithm throughout: EdDSA over Ed25519. The mobile app has to verify an
 * offline grant on launch, on a cheap phone, with no network — a 32-byte public
 * key and a fast verification make that unremarkable. It is asymmetric so that
 * the key shipped inside the app can check a token but never mint one.
 *
 * Verification accepts a set of keys, not one. Rotating a signing key means
 * publishing the new public key first, switching the signer once every client
 * has it, and retiring the old one only after every token it signed has
 * expired — which, with a seven-day offline grant, is seven days. Rotation is
 * therefore a planned week, not an afternoon, and the shape of this module is
 * what makes it possible at all.
 */

export const ALGORITHM = 'EdDSA';
const CURVE = 'Ed25519';

/**
 * Whatever `importJWK` hands back on this runtime.
 *
 * Named indirectly because `CryptoKey` is a DOM global, and pulling the DOM lib
 * into a Node package to borrow one type would bring `document` and `window`
 * with it.
 */
export type ImportedKey = Awaited<ReturnType<typeof importJWK>>;

const jwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal(CURVE),
  x: z.string().min(1),
  d: z.string().min(1).optional(),
  kid: z.string().min(1),
});

export interface SigningKey {
  kid: string;
  key: ImportedKey;
}

export interface VerificationKeySet {
  /** Looks a key up by `kid`; returns undefined for one this deployment does not know. */
  find: (kid: string) => Promise<ImportedKey | undefined>;
  /** The public JWKs, for publishing at a JWKS endpoint and for embedding in the mobile app. */
  publicJwks: () => JWK[];
  kids: () => string[];
}

export class KeyConfigurationError extends Error {
  constructor(message: string) {
    super(`${message}\n\nRun "pnpm --filter @integr8/auth keygen" to generate a fresh key pair.`);
    this.name = 'KeyConfigurationError';
  }
}

/** Parses `AUTH_SIGNING_KEY` and checks it is a private key with the expected id. */
export async function loadSigningKey(config: AuthConfig): Promise<SigningKey> {
  const jwk = parseJwk(config.AUTH_SIGNING_KEY, 'AUTH_SIGNING_KEY');

  if (jwk.d === undefined) {
    throw new KeyConfigurationError('AUTH_SIGNING_KEY is a public key; a private key is required.');
  }
  if (jwk.kid !== config.AUTH_SIGNING_KEY_ID) {
    throw new KeyConfigurationError(
      `AUTH_SIGNING_KEY has kid "${jwk.kid}" but AUTH_SIGNING_KEY_ID is "${config.AUTH_SIGNING_KEY_ID}". A token signed under one id and announced under another cannot be verified.`,
    );
  }

  return { kid: jwk.kid, key: await importJWK(toJwk(jwk), ALGORITHM) };
}

/**
 * Parses `AUTH_VERIFICATION_KEYS`, rejecting any that carries private material.
 *
 * Verification keys are published — at a JWKS endpoint, and inside a mobile
 * binary that anyone can extract. A private key reaching this list would be a
 * private key on the App Store, so it is refused here rather than trusted not
 * to happen.
 */
export async function loadVerificationKeys(config: AuthConfig): Promise<VerificationKeySet> {
  const parsed: unknown = safeJsonParse(config.AUTH_VERIFICATION_KEYS, 'AUTH_VERIFICATION_KEYS');

  if (!Array.isArray(parsed)) {
    throw new KeyConfigurationError('AUTH_VERIFICATION_KEYS must be a JSON array of JWKs.');
  }

  const jwks = parsed.map((entry, index) => {
    const result = jwkSchema.safeParse(entry);
    if (!result.success) {
      throw new KeyConfigurationError(
        `AUTH_VERIFICATION_KEYS[${String(index)}] is not an Ed25519 JWK with a kid.`,
      );
    }
    if (result.data.d !== undefined) {
      throw new KeyConfigurationError(
        `AUTH_VERIFICATION_KEYS[${String(index)}] contains private key material. These keys are published; strip "d".`,
      );
    }
    return result.data;
  });

  if (jwks.length === 0) {
    throw new KeyConfigurationError('AUTH_VERIFICATION_KEYS is empty; no token could be verified.');
  }

  const duplicates = jwks
    .map((jwk) => jwk.kid)
    .filter((kid, index, all) => all.indexOf(kid) !== index);
  if (duplicates.length > 0) {
    throw new KeyConfigurationError(
      `AUTH_VERIFICATION_KEYS contains two keys with kid "${duplicates[0] ?? ''}".`,
    );
  }

  if (!jwks.some((jwk) => jwk.kid === config.AUTH_SIGNING_KEY_ID)) {
    throw new KeyConfigurationError(
      `AUTH_VERIFICATION_KEYS does not include the signing key "${config.AUTH_SIGNING_KEY_ID}". This deployment would issue tokens it could not verify.`,
    );
  }

  const imported = new Map<string, ImportedKey>();
  for (const jwk of jwks) {
    imported.set(jwk.kid, await importJWK(toJwk(jwk), ALGORITHM));
  }

  return {
    find: (kid: string) => Promise.resolve(imported.get(kid)),
    publicJwks: () => jwks.map((jwk) => ({ ...toJwk(jwk), alg: ALGORITHM, use: 'sig' })),
    kids: () => [...imported.keys()],
  };
}

export interface GeneratedKeyPair {
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
}

/**
 * Generates a key pair for a new environment or a rotation.
 *
 * The `kid` embeds the date it was made, so that a JWKS with three keys in it
 * can be read without consulting anything else.
 */
export async function generateSigningKeyPair(now: Date = new Date()): Promise<GeneratedKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, {
    crv: CURVE,
    extractable: true,
  });

  const kid = `integr8-${now.toISOString().slice(0, 10)}-${randomSuffix()}`;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: ALGORITHM, use: 'sig' };
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: ALGORITHM, use: 'sig' };

  return { kid, privateJwk, publicJwk };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function parseJwk(raw: string, variable: string): z.infer<typeof jwkSchema> {
  const result = jwkSchema.safeParse(safeJsonParse(raw, variable));
  if (!result.success) {
    throw new KeyConfigurationError(
      `${variable} is not an Ed25519 JWK with a kid: ${result.error.issues.map((issue) => issue.message).join(', ')}`,
    );
  }
  return result.data;
}

/**
 * Converts the parsed shape into a `JWK`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and zod produces the latter for an optional field. A public key
 * must not carry a `d` key holding `undefined`, so it is omitted rather than
 * set.
 */
function toJwk(parsed: z.infer<typeof jwkSchema>): JWK {
  const jwk: JWK = { kty: parsed.kty, crv: parsed.crv, x: parsed.x, kid: parsed.kid };
  return parsed.d === undefined ? jwk : { ...jwk, d: parsed.d };
}

function safeJsonParse(raw: string, variable: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new KeyConfigurationError(`${variable} is not valid JSON.`);
  }
}
