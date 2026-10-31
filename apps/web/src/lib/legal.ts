import { LEGAL_OPERATOR, type LegalDocument, type LegalOperator } from '@integr8/core';
import type { TFunction } from '@integr8/i18n';
import { contactEmail } from './signup';

/**
 * What the legal pages render, in order (High 10).
 *
 * The words are `legal.*` in `@integr8/i18n`; the order of the sections is
 * here, one list per document, so every key the page asks for is checked by
 * the compiler. A test compares each list with the English catalogue, so a
 * section added there and forgotten here fails rather than vanishing.
 */

export const TERMS_SECTIONS = [
  'about',
  'service',
  'accounts',
  'data',
  'acceptableUse',
  'staffAccess',
  'fees',
  'suspension',
  'availability',
  'records',
  'assistant',
  'ending',
  'liability',
  'changes',
  'law',
  'contact',
] as const;

export const PRIVACY_SECTIONS = [
  'who',
  'roles',
  'collect',
  'use',
  'cookies',
  'sharing',
  'location',
  'security',
  'retention',
  'rights',
  'children',
  'changes',
  'contact',
] as const;

export const DPA_SECTIONS = [
  'scope',
  'details',
  'instructions',
  'people',
  'security',
  'subprocessors',
  'transfers',
  'assistance',
  'breaches',
  'audits',
  'ending',
  'company',
  'contact',
] as const;

export interface LegalSection {
  /** The anchor, so a section can be linked to: `/legal/privacy#rights`. */
  id: string;
  title: string;
  body: string;
}

/** A document's sections in the reader's language, with the contact address filled in. */
export function legalSections(document: LegalDocument, t: TFunction): LegalSection[] {
  const email = legalContactEmail();
  switch (document) {
    case 'terms':
      return TERMS_SECTIONS.map((id) => ({
        id,
        title: t(`legal.terms.sections.${id}.title`),
        body: t(`legal.terms.sections.${id}.body`, { email }),
      }));
    case 'privacy':
      return PRIVACY_SECTIONS.map((id) => ({
        id,
        title: t(`legal.privacy.sections.${id}.title`),
        body: t(`legal.privacy.sections.${id}.body`, { email }),
      }));
    case 'dpa':
      return DPA_SECTIONS.map((id) => ({
        id,
        title: t(`legal.dpa.sections.${id}.title`),
        body: t(`legal.dpa.sections.${id}.body`, { email }),
      }));
  }
}

/**
 * Where requests about personal data go: the operator's privacy address once
 * there is one, until then the address the contact page already gives.
 */
export function legalContactEmail(operator: LegalOperator = LEGAL_OPERATOR): string {
  const dedicated = operator.privacyEmail?.trim() ?? '';
  return dedicated === '' ? contactEmail() : dedicated;
}

export interface OperatorRow {
  /** Which `legal.operator.*` label the value goes under. */
  key: Exclude<keyof LegalOperator, 'privacyEmail'> | 'email';
  value: string;
}

/**
 * The operator's details that are known, in the order the page lists them.
 * A missing one is left out rather than shown as a blank or a placeholder:
 * `missingOperatorDetails()` in `@integr8/core` is where the gaps are tracked.
 */
export function operatorRows(operator: LegalOperator = LEGAL_OPERATOR): OperatorRow[] {
  const rows: OperatorRow[] = [];
  for (const key of [
    'legalName',
    'registeredAddress',
    'commercialRegistration',
    'taxRegistration',
    'hostingLocation',
  ] as const) {
    const value = operator[key]?.trim() ?? '';
    if (value !== '') {
      rows.push({ key, value });
    }
  }
  rows.push({ key: 'email', value: legalContactEmail(operator) });
  return rows;
}

export type LegalBlock = { kind: 'paragraph'; text: string } | { kind: 'list'; items: string[] };

/**
 * A section's body as paragraphs and lists.
 *
 * The catalogue's two rules and nothing more: a blank line starts a new
 * block, and lines starting with "- " are list items. A line of prose before
 * the items (such as "We use personal data to:") stays a paragraph of its own.
 */
export function parseLegalBody(body: string): LegalBlock[] {
  const blocks: LegalBlock[] = [];
  for (const chunk of body.split(/\n\s*\n/u)) {
    let prose: string[] = [];
    let items: string[] = [];
    const flushProse = () => {
      if (prose.length > 0) {
        blocks.push({ kind: 'paragraph', text: prose.join(' ') });
        prose = [];
      }
    };
    const flushItems = () => {
      if (items.length > 0) {
        blocks.push({ kind: 'list', items });
        items = [];
      }
    };
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (line === '') {
        continue;
      }
      if (line.startsWith('- ')) {
        flushProse();
        items.push(line.slice(2).trim());
      } else {
        flushItems();
        prose.push(line);
      }
    }
    flushProse();
    flushItems();
  }
  return blocks;
}
