/**
 * The links this system puts in other people's hands (P18).
 *
 * One place, because there were three copies of the accept-invitation URL by
 * the time P18 started — two in the platform routes and one implied by the web
 * app — and a link that is built in three places is a link that is wrong in
 * two of them eventually.
 *
 * Every builder returns **null rather than a guess** when no web address is
 * configured. A half-right link is worse than none: the person tries it, it
 * fails, and nobody finds out until they give up.
 */

function base(url: string | undefined): string | null {
  return url === undefined || url === '' ? null : url.replace(/\/+$/u, '');
}

/** Where an invitee goes to accept. The token is the capability; treat as a secret. */
export function acceptInvitationUrl(webAppUrl: string | undefined, token: string): string | null {
  const root = base(webAppUrl);
  return root === null ? null : `${root}/accept-invitation?token=${encodeURIComponent(token)}`;
}

/** Where somebody who has just signed up proves they own the address. */
export function verifySignupUrl(webAppUrl: string | undefined, token: string): string | null {
  const root = base(webAppUrl);
  return root === null ? null : `${root}/sign-up/verify?token=${encodeURIComponent(token)}`;
}

/** The company's own billing screen, for a dunning message to point at. */
export function billingUrl(webAppUrl: string | undefined): string | null {
  const root = base(webAppUrl);
  return root === null ? null : `${root}/billing`;
}
