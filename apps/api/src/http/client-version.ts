/**
 * Whether a client build is still supported.
 *
 * The problem this exists for: a signed desktop binary and an App Store build
 * cannot be force-updated. At any moment some traffic comes from software
 * written months ago, and the failure mode without this check is an old client
 * calling an endpoint whose response has changed and misbehaving in a way
 * neither the user nor the log can explain.
 *
 * So every response carries `min-supported-client`, and a client below it is
 * told so directly — once, clearly, with somewhere to go — instead of being
 * allowed to fail confusingly later.
 */

export interface ClientVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses `1.4.2`, ignoring any pre-release or build suffix.
 *
 * Lenient on purpose: a client sending `1.4.2-beta.3` or `1.4.2+ci.99` is on
 * build 1.4.2 as far as support goes, and refusing to parse it would lock out
 * exactly the people testing the next release.
 */
export function parseClientVersion(raw: string | undefined | null): ClientVersion | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(raw.trim());
  if (match === null) {
    return undefined;
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt(match[2] ?? '0', 10),
    patch: Number.parseInt(match[3] ?? '0', 10),
  };
}

/** Negative when `a` is older, zero when equal, positive when newer. */
export function compareVersions(a: ClientVersion, b: ClientVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export type ClientVersionVerdict =
  | { supported: true; reason: 'current' | 'not_declared' }
  | { supported: false; reason: 'too_old'; minimum: string; declared: string };

/**
 * Decides whether to serve a request.
 *
 * A client that declares no version is served. That is deliberate: `curl`, a
 * health check and a partner integration all have legitimate reasons not to
 * send one, and refusing them would make the header a de-facto authentication
 * mechanism it was never designed to be. The clients that matter here — the
 * ones that cannot be updated — are exactly the ones that do send it.
 */
export function assessClientVersion(
  declared: string | undefined | null,
  minimumSupported: string,
): ClientVersionVerdict {
  const client = parseClientVersion(declared);
  if (client === undefined) {
    return { supported: true, reason: 'not_declared' };
  }

  const minimum = parseClientVersion(minimumSupported);
  if (minimum === undefined) {
    // A malformed minimum is our misconfiguration, not the caller's problem.
    return { supported: true, reason: 'not_declared' };
  }

  return compareVersions(client, minimum) >= 0
    ? { supported: true, reason: 'current' }
    : {
        supported: false,
        reason: 'too_old',
        minimum: minimumSupported,
        declared: declared?.trim() ?? '',
      };
}

/**
 * The message an out-of-date client shows its user.
 *
 * Written to be rendered as-is. A client too old to understand a new error
 * shape can still display a string, so this has to make sense on its own — it
 * says what happened, what to do, and where to go.
 */
export function outdatedClientMessage(verdict: {
  minimum: string;
  declared: string;
  updateUrl: string;
}): string {
  return [
    `This version of the app (${verdict.declared}) is no longer supported.`,
    `Please update to ${verdict.minimum} or later to continue.`,
    `Get the latest version at ${verdict.updateUrl}`,
  ].join(' ');
}
