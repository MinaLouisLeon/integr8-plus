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
