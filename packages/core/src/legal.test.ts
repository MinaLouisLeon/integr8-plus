import { describe, expect, it } from 'vitest';
import {
  LEGAL_DOCUMENTS,
  LEGAL_LAST_UPDATED,
  LEGAL_OPERATOR,
  legalPath,
  legalUrl,
  missingOperatorDetails,
} from './legal.js';

describe('the legal pages', () => {
  it('live under /legal on the website, and on the operator’s site for the other apps', () => {
    expect(LEGAL_DOCUMENTS.map(legalPath)).toEqual([
      '/legal/terms',
      '/legal/privacy',
      '/legal/dpa',
    ]);
    expect(legalUrl('privacy')).toBe('https://app.integr8-media.com/legal/privacy');
    expect(legalUrl('dpa', 'http://localhost:3001/')).toBe('http://localhost:3001/legal/dpa');
  });

  it('carry a real calendar date', () => {
    expect(LEGAL_LAST_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(Number.isNaN(Date.parse(LEGAL_LAST_UPDATED))).toBe(false);
  });

  it('list the operator details still missing, and nothing once they are filled in', () => {
    // Today every detail is missing on purpose: none may be guessed. This
    // pins the list, so filling one in is a change somebody sees here.
    expect(missingOperatorDetails()).toEqual(Object.keys(LEGAL_OPERATOR));
    expect(
      missingOperatorDetails({
        legalName: 'A Company',
        registeredAddress: 'An address',
        commercialRegistration: '1',
        taxRegistration: '2',
        privacyEmail: 'privacy@example.com',
        hostingLocation: '  ',
      }),
    ).toEqual(['hostingLocation']);
  });
});
