import { describe, expect, it } from 'vitest';
import {
  assetTagLinkFor,
  documentLink,
  documentLinkPatternProblem,
  hasCompanySite,
  isLocalWebAddress,
  quoteLink,
} from './render.js';

describe('outside links point at the company’s own website only', () => {
  it('are none at all while the company has no website', () => {
    expect(documentLink('abc', { websiteUrl: null })).toBeNull();
    expect(documentLink('abc', { websiteUrl: '  ', documentLinkPattern: null })).toBeNull();
    expect(quoteLink('tok', null)).toBeNull();
    expect(assetTagLinkFor('ABC123', null)).toBeNull();
    expect(hasCompanySite({ websiteUrl: null })).toBe(false);
  });

  it('open the company’s site, never Integr8’s', () => {
    const site = { websiteUrl: 'https://example.com/' };
    expect(hasCompanySite(site)).toBe(true);
    expect(documentLink('abc_-1', site)).toBe('https://example.com/documents/abc_-1');
    expect(quoteLink('tok', site.websiteUrl)).toBe('https://example.com/q/tok');
    expect(assetTagLinkFor('ABC123', site.websiteUrl)).toBe('https://example.com/a/ABC123');
  });

  it('follow the company’s document link pattern when it has one', () => {
    expect(
      documentLink('abc', {
        websiteUrl: 'https://example.com',
        documentLinkPattern: 'https://example.com/d?code={code}',
      }),
    ).toBe('https://example.com/d?code=abc');
  });
});

describe('a document link address', () => {
  const site = 'https://www.example.com';

  it('is accepted on the registered website or a host under it', () => {
    expect(documentLinkPatternProblem('https://example.com/documents/{code}', site)).toBeNull();
    expect(documentLinkPatternProblem('https://www.example.com/d/{code}', site)).toBeNull();
    expect(documentLinkPatternProblem('https://docs.example.com/{code}', site)).toBeNull();
  });

  it('is refused anywhere else, or without a website', () => {
    expect(documentLinkPatternProblem('https://example.org/{code}', site)).toBe(
      'document_link_other_site',
    );
    expect(documentLinkPatternProblem('https://notexample.com/{code}', site)).toBe(
      'document_link_other_site',
    );
    expect(documentLinkPatternProblem('https://example.com/{code}', null)).toBe(
      'document_link_needs_website',
    );
  });

  it('must be https, carry the code outside the host, and have no spaces', () => {
    expect(documentLinkPatternProblem('http://example.com/{code}', site)).toBe(
      'document_link_invalid',
    );
    expect(documentLinkPatternProblem('https://example.com/documents', site)).toBe(
      'document_link_invalid',
    );
    expect(documentLinkPatternProblem('https://{code}.example.com/', site)).toBe(
      'document_link_invalid',
    );
    expect(documentLinkPatternProblem('https://example.com/a b/{code}', site)).toBe(
      'document_link_invalid',
    );
  });
});

describe('a test company on the developer’s machine (P43)', () => {
  const local = 'http://localhost:3000';

  it('may point its links at localhost or 127.0.0.1', () => {
    expect(
      documentLinkPatternProblem('http://localhost:3000/documents/{code}', local, true),
    ).toBeNull();
    expect(
      documentLinkPatternProblem('http://127.0.0.1:3000/d/{code}', 'http://127.0.0.1:3000', true),
    ).toBeNull();
  });

  it('still needs the same website, and no other http address', () => {
    expect(
      documentLinkPatternProblem('http://localhost:3000/{code}', 'https://example.com', true),
    ).toBe('document_link_other_site');
    expect(
      documentLinkPatternProblem('http://example.com/{code}', 'https://example.com', true),
    ).toBe('document_link_invalid');
  });

  it('is refused for every other company', () => {
    expect(documentLinkPatternProblem('http://localhost:3000/documents/{code}', local)).toBe(
      'document_link_invalid',
    );
  });

  it('is told apart from a real address', () => {
    expect(isLocalWebAddress('http://localhost:3000')).toBe(true);
    expect(isLocalWebAddress('http://127.0.0.1')).toBe(true);
    expect(isLocalWebAddress('https://localhost:3000')).toBe(false);
    expect(isLocalWebAddress('http://localhost.example.com')).toBe(false);
    expect(isLocalWebAddress('not an address')).toBe(false);
  });
});
