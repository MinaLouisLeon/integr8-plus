/**
 * Where to go after signing in, when a signed-out visitor was sent to sign
 * in from a page they wanted: a scanned asset tag, a shared job link.
 *
 * Only a path on this site is accepted. Anything else — another origin, a
 * protocol-relative `//host`, a backslash trick, a script URL — sends the
 * person to the dashboard, so the parameter can never be used to bounce
 * someone to a page that only looks like ours.
 */
export function safeReturnPath(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined || raw.length === 0 || raw.length > 500) {
    return undefined;
  }
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) {
    return undefined;
  }
  // Control characters (a tab or newline can turn `/\t/host` into `//host`).
  if (/\p{Cc}/u.test(raw)) {
    return undefined;
  }
  try {
    const parsed = new URL(raw, 'https://same.invalid');
    if (parsed.origin !== 'https://same.invalid') {
      return undefined;
    }
    if (parsed.pathname === '/sign-in' || parsed.pathname.startsWith('/sign-in/')) {
      return undefined;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return undefined;
  }
}

/** The sign-in page that comes back to `path`. */
export function signInReturningTo(path: string): string {
  const back = safeReturnPath(path);
  return back === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(back)}`;
}
