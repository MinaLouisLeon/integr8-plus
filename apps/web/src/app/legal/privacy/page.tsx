import { LegalDocumentPage } from '~/components/legal-document';
import { legalMetadata } from '~/lib/legal-metadata';

/**
 * The privacy policy (High 10). Public, like the rest of the marketing site,
 * and the address the app store listings give, so it must not move:
 * `legalUrl('privacy')` in `@integr8/core`.
 */
export function generateMetadata() {
  return legalMetadata('privacy');
}

export default function PrivacyPage() {
  return <LegalDocumentPage document="privacy" />;
}
