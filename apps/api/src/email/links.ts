/**
 * The links this system puts in other people's hands (P18).
 *
 * One place, so a link is built once. Since P42 there is one: accepting an
 * invitation, on the public site. Reminders name a screen in the company's
 * desktop app instead of linking to a web workspace that no longer exists.
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
