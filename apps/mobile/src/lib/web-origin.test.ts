import { describe, expect, it } from 'vitest';
import { originOf, sameOrigin } from './web-origin';

describe('originOf', () => {
  it('keeps the scheme, host and an explicit non-default port', () => {
    expect(originOf('https://Northwind.example/jobs?x=1#top')).toBe('https://northwind.example');
    expect(originOf('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(originOf('https://northwind.example:443/about')).toBe('https://northwind.example');
    expect(originOf('https://user:pw@northwind.example/')).toBe('https://northwind.example');
  });

  it('is null for anything that is not a web address', () => {
    for (const value of [
      '',
      'about:blank',
      'mailto:ed@example.com',
      'tel:+441130000000',
      '/relative',
    ]) {
      expect(originOf(value), value).toBeNull();
    }
  });
});

describe('sameOrigin', () => {
  it('is true within the site and false for every other host', () => {
    const site = 'https://northwind.example';
    expect(sameOrigin(`${site}/contact`, site)).toBe(true);
    expect(sameOrigin('https://www.northwind.example/', site)).toBe(false);
    expect(sameOrigin('http://northwind.example/', site)).toBe(false);
    expect(sameOrigin('https://maps.google.example/', site)).toBe(false);
    expect(sameOrigin('mailto:hello@northwind.example', site)).toBe(false);
  });
});
