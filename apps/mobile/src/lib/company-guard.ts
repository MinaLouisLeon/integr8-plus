import { COMPANY } from './company';
import { session } from './session';

/**
 * A company's app signs in to that company and no other.
 *
 * The API already refuses an account from another company when `companySlug`
 * is sent with the sign-in (`wrong_company`). This is the belt to that brace:
 * once signed in, `/v1/me` is asked whose account this is, and a mismatch ends
 * the session before a single job is downloaded. Here rather than in a screen,
 * because screens never call the API (see `eslint.config.js`).
 */
export type CompanyCheck = 'ok' | 'wrong_company';

export async function verifySignedInCompany(): Promise<CompanyCheck> {
  if (COMPANY === undefined) {
    return 'ok';
  }
  try {
    const { data } = await session().client.GET('/v1/me');
    if (data !== undefined && data.company.slug !== COMPANY.slug) {
      await session().signOut();
      return 'wrong_company';
    }
  } catch {
    // Unreachable right after a sign-in that just succeeded is a dropped
    // connection, not a different company; the first download checks the identity.
  }
  return 'ok';
}
