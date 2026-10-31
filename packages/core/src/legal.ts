/**
 * The legal pages, and who stands behind them (pre-production audit, High 10).
 *
 * The terms of service, the privacy policy and the data processing terms are
 * pages on the website (`apps/web/src/app/legal/…`, words in `@integr8/i18n`
 * under `legal`). The desktop app, the phone app and the store listings link
 * to them, so their addresses are decided here, once, where every app can read
 * them. `docs/legal/README.md` says what each text covers and what must happen
 * before launch.
 */

export const LEGAL_DOCUMENTS = ['terms', 'privacy', 'dpa'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** The day the texts last changed. Changing a text means changing this. */
export const LEGAL_LAST_UPDATED = '2026-10-31';

/**
 * Whether a lawyer has reviewed the texts. While false, each page says so
 * under its title: the texts describe the product accurately, but nobody
 * qualified in Egyptian law has signed them off yet.
 */
export const LEGAL_REVIEWED = false;

/**
 * Where the published pages live, for apps that are not the website: the
 * desktop and phone apps open these in the browser, and the app store
 * listings need a privacy policy address that never moves. The pages belong
 * to the operator, not to a deployment, so a staging build links here too.
 */
export const LEGAL_SITE_ORIGIN = 'https://app.integr8-media.com';

/** The path of a legal page on the website. */
export function legalPath(document: LegalDocument): `/legal/${LegalDocument}` {
  return `/legal/${document}`;
}

/** The full address of a legal page, on the operator's site unless told otherwise. */
export function legalUrl(document: LegalDocument, origin: string = LEGAL_SITE_ORIGIN): string {
  return `${origin.replace(/\/+$/u, '')}${legalPath(document)}`;
}

/**
 * The business that provides Integr8 Plus, as the texts name it.
 *
 * `null` means **not known yet**. Nothing here may be guessed: a registered
 * name, address or registration number that is wrong is worse than none. The
 * pages leave out whatever is still `null` rather than print a placeholder,
 * so {@link missingOperatorDetails} is the list to clear before launch.
 */
export interface LegalOperator {
  /** The registered name of the business, exactly as on the commercial register. */
  legalName: string | null;
  /** Its registered address. */
  registeredAddress: string | null;
  /** Its commercial registration number. */
  commercialRegistration: string | null;
  /** Its tax registration number. */
  taxRegistration: string | null;
  /**
   * Where requests about personal data go. While `null` the pages give the
   * website's contact address (`NEXT_PUBLIC_CONTACT_EMAIL`), which is
   * monitored today; a dedicated address is better once there is one.
   */
  privacyEmail: string | null;
  /**
   * The country (and Oracle Cloud region) the server runs in, such as
   * "Germany (Oracle Cloud, Frankfurt)". The privacy policy names it.
   */
  hostingLocation: string | null;
}

// ---------------------------------------------------------------------------
// TO BE FILLED IN BEFORE LAUNCH, by the owner, with an Egyptian lawyer.
// Every `null` below is missing information, not a deliberate blank.
// ---------------------------------------------------------------------------
export const LEGAL_OPERATOR: LegalOperator = {
  legalName: null,
  registeredAddress: null,
  commercialRegistration: null,
  taxRegistration: null,
  privacyEmail: null,
  hostingLocation: null,
};

/** The operator details still missing: empty means ready to publish. */
export function missingOperatorDetails(
  operator: LegalOperator = LEGAL_OPERATOR,
): (keyof LegalOperator)[] {
  return (Object.keys(operator) as (keyof LegalOperator)[]).filter((key) => {
    const value = operator[key];
    return value === null || value.trim() === '';
  });
}
