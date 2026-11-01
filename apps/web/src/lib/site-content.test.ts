import { ar, en } from '@integr8/i18n/core';
import { describe, expect, it } from 'vitest';
import { FEATURE_GROUPS, FEATURES, HIGHLIGHTS } from './site-content';

/**
 * The public pages name their content by key; the words are in both
 * catalogues. The catalogue parity test checks English and Arabic agree with
 * each other; this checks the pages ask for nothing either lacks.
 */
describe('the public site content', () => {
  it('lists fifteen distinct features, each in both languages', () => {
    expect(FEATURES).toHaveLength(15);
    expect(new Set(FEATURES.map((feature) => feature.key)).size).toBe(15);
    for (const { key } of FEATURES) {
      expect(en.site.features.items[key].title, key).not.toBe('');
      expect(ar.site.features.items[key].title, key).not.toBe('');
      expect(ar.site.features.items[key].body, key).not.toBe(en.site.features.items[key].body);
    }
  });

  it('has no feature in the catalogue that the page leaves out', () => {
    expect(Object.keys(en.site.features.items).sort()).toEqual(
      FEATURES.map((feature) => feature.key).sort(),
    );
  });

  it('groups every feature under a named group', () => {
    for (const { group } of FEATURES) {
      expect(FEATURE_GROUPS).toContain(group);
      expect(ar.site.features.groups[group]).not.toBe(en.site.features.groups[group]);
    }
  });

  it('highlights only features the features page lists', () => {
    const keys = new Set(FEATURES.map((feature) => feature.key));
    for (const key of HIGHLIGHTS) {
      expect(keys.has(key), key).toBe(true);
    }
  });
});
