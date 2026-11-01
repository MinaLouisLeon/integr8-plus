import { LegalDocumentPage } from '~/components/legal-document';
import { legalMetadata } from '~/lib/legal-metadata';

/** The terms of service (High 10). Public, like the rest of the marketing site. */
export function generateMetadata() {
  return legalMetadata('terms');
}

export default function TermsPage() {
  return <LegalDocumentPage document="terms" />;
}
