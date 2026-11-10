/**
 * Hiding secrets before anything is written or returned (P38).
 *
 * The trace and every tool result go through here: tokens, passwords, sign-in
 * codes, `Authorization` and cookie headers, and signed file links become
 * `[hidden]`. The AI tool never needs any of them to read what a request did,
 * and a trace file left in the temporary folder must not be a key to anything.
 */

export const HIDDEN = '[hidden]';

/** Keys whose value is a secret wherever they appear. */
const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|password|newpassword|currentpassword|secret|token|accesstoken|refreshtoken|idtoken|apikey|api-key|x-api-key|websitekey|totp|otp|privatekey|clientsecret)$/iu;

/** Keys that hold a one-time sign-in code on the sign-in routes. */
const CODE_KEYS = /^(code|signincode)$/iu;

/** A JSON Web Token: three base64url parts, the first starting with `eyJ`. */
const JWT = /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}\b/gu;
/** Integr8's own refresh tokens and invitation tokens carry a prefix. */
const INTEGR8_TOKEN = /\bi8[a-z]\d\.[\w.-]{16,}/gu;
/** A signed link (R2/S3 presigned, or a token in the query). */
const SIGNED_LINK =
  /https?:\/\/[^\s"']*[?&](?:X-Amz-Signature|X-Amz-Credential|Signature|signature|sig|token|key)=[^\s"']*/gu;

function redactString(value: string): string {
  return value.replace(SIGNED_LINK, HIDDEN).replace(JWT, HIDDEN).replace(INTEGR8_TOKEN, HIDDEN);
}

/**
 * A copy of `value` with secrets replaced. `authPath` says the value belongs
 * to a sign-in route, where a field called `code` is a one-time code.
 */
export function redact(value: unknown, options: { authPath?: boolean } = {}): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, options));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEYS.test(key) || (options.authPath === true && CODE_KEYS.test(key))) {
      copy[key] = HIDDEN;
    } else if (key === 'tokens' && typeof inner === 'object' && inner !== null) {
      copy[key] = HIDDEN;
    } else {
      copy[key] = redact(inner, options);
    }
  }
  return copy;
}

/** Headers, as a plain object, with every secret one hidden. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return redact(headers) as Record<string, string>;
}

/** Whether a path is one where `code` means a sign-in code. */
export const isAuthPath = (path: string) =>
  path.includes('/auth/') || path.includes('/me/password');
