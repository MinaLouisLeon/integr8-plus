/**
 * Whether this build offers public sign-up (P18's self-serve flow).
 *
 * Off by default: companies are set up by Integr8 from the platform dashboard,
 * which builds their forms and job types with them. So the marketing pages
 * send a visitor to the contact page rather than to a form, and the sign-up
 * pages themselves say so if somebody arrives with an old link.
 *
 * The switch is `NEXT_PUBLIC_SIGNUP`, baked into the bundle at build time, and
 * the API has its own copy (`PUBLIC_SIGNUP`); a page that showed a form the API
 * refuses would be worse than either alone, so deployments set both.
 */

export type SignupMode = 'off' | 'open';

export function signupMode(raw: string | undefined = process.env.NEXT_PUBLIC_SIGNUP): SignupMode {
  return raw === 'open' ? 'open' : 'off';
}

/** Where the "get started" button on every public page goes. */
export function getStartedHref(mode: SignupMode = signupMode()): '/sign-up' | '/contact' {
  return mode === 'open' ? '/sign-up' : '/contact';
}

/**
 * Where the contact page tells people to write. A deployment sets
 * `NEXT_PUBLIC_CONTACT_EMAIL`; the fallback is Integr8's own address so the
 * page is never a dead end.
 */
export function contactEmail(
  raw: string | undefined = process.env.NEXT_PUBLIC_CONTACT_EMAIL,
): string {
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? 'hello@integr8-media.com' : trimmed;
}
