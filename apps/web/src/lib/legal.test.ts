import { LEGAL_OPERATOR } from '@integr8/core';
import { ar, createI18n, en } from '@integr8/i18n';
import { describe, expect, it } from 'vitest';
import {
  DPA_SECTIONS,
  legalContactEmail,
  legalSections,
  operatorRows,
  parseLegalBody,
  PRIVACY_SECTIONS,
  TERMS_SECTIONS,
} from './legal';

/**
 * The legal pages (High 10): every section the catalogue has is on the page,
 * in both languages, with the contact address filled in, and nothing the
 * operator has not supplied is printed.
 */

describe('the legal pages', () => {
  it('render every section the catalogue holds, in the catalogue’s order', () => {
    expect([...TERMS_SECTIONS]).toEqual(Object.keys(en.legal.terms.sections));
    expect([...PRIVACY_SECTIONS]).toEqual(Object.keys(en.legal.privacy.sections));
    expect([...DPA_SECTIONS]).toEqual(Object.keys(en.legal.dpa.sections));
    expect([...PRIVACY_SECTIONS]).toEqual(Object.keys(ar.legal.privacy.sections));
  });

  it('fill in the contact address, in Arabic as in English', () => {
    const email = legalContactEmail();
    for (const locale of ['en', 'ar'] as const) {
      const { t } = createI18n({ locale });
      const contact = legalSections('privacy', t).find((section) => section.id === 'contact');
      expect(contact?.body).toContain(email);
      expect(contact?.body).not.toContain('{{');
      for (const document of ['terms', 'privacy', 'dpa'] as const) {
        for (const section of legalSections(document, t)) {
          expect(section.title, `${locale} ${document}.${section.id}`).not.toBe('');
          expect(section.body, `${locale} ${document}.${section.id}`).not.toContain('legal.');
        }
      }
    }
  });

  it('give the contact page’s address until there is one for privacy', () => {
    expect(legalContactEmail({ ...LEGAL_OPERATOR, privacyEmail: null })).toBe(
      'hello@integr8-media.com',
    );
    expect(legalContactEmail({ ...LEGAL_OPERATOR, privacyEmail: ' privacy@example.com ' })).toBe(
      'privacy@example.com',
    );
  });

  it('list only the operator details that are known, never a blank', () => {
    expect(operatorRows({ ...LEGAL_OPERATOR, legalName: null, registeredAddress: '  ' })).toEqual([
      { key: 'email', value: 'hello@integr8-media.com' },
    ]);
    expect(
      operatorRows({
        legalName: 'A Company',
        registeredAddress: 'An address',
        commercialRegistration: '123',
        taxRegistration: '456',
        privacyEmail: 'privacy@example.com',
        hostingLocation: 'Somewhere',
      }).map((row) => row.key),
    ).toEqual([
      'legalName',
      'registeredAddress',
      'commercialRegistration',
      'taxRegistration',
      'hostingLocation',
      'email',
    ]);
  });
});

describe('a section’s body', () => {
  it('is paragraphs split by blank lines', () => {
    expect(parseLegalBody('One.\n\nTwo.')).toEqual([
      { kind: 'paragraph', text: 'One.' },
      { kind: 'paragraph', text: 'Two.' },
    ]);
  });

  it('turns "- " lines into a list, keeping the line that introduces it', () => {
    expect(parseLegalBody('We use it to:\n- sign in;\n- bill.\n\nAfter.')).toEqual([
      { kind: 'paragraph', text: 'We use it to:' },
      { kind: 'list', items: ['sign in;', 'bill.'] },
      { kind: 'paragraph', text: 'After.' },
    ]);
  });

  it('reads every real section into something to show', () => {
    for (const catalogue of [en, ar]) {
      for (const document of [
        catalogue.legal.terms,
        catalogue.legal.privacy,
        catalogue.legal.dpa,
      ]) {
        for (const section of Object.values(document.sections)) {
          const blocks = parseLegalBody(section.body);
          expect(blocks.length).toBeGreaterThan(0);
          for (const block of blocks) {
            if (block.kind === 'list') {
              expect(block.items.every((item) => item !== '')).toBe(true);
            } else {
              expect(block.text.startsWith('- ')).toBe(false);
            }
          }
        }
      }
    }
  });
});
