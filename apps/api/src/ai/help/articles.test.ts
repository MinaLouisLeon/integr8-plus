import { isPermission, MODULE_FEATURES, NAV_SECTIONS } from '@integr8/core';
import { HELP_ARTICLES } from '@integr8/i18n/help';
import { describe, expect, it } from 'vitest';

/**
 * The help library against the product's own vocabulary (Low 12). The library
 * lives in `@integr8/i18n/help`, which knows nothing of modules, permissions
 * or screens; the API does, and it is the API that filters articles by them
 * (`retrieveReferences` in ../chat.ts). A name that does not exist would
 * quietly hide an article from everybody, or show it to everybody.
 */

describe('the help library', () => {
  it('has at least one article for every module a company can have switched on', () => {
    const covered = new Set(
      HELP_ARTICLES.flatMap((article) => [
        ...(article.feature === null ? [] : [article.feature]),
        ...(article.covers ?? []),
      ]),
    );
    expect(MODULE_FEATURES.filter((feature) => !covered.has(feature))).toEqual([]);
  });

  it('names only modules that exist', () => {
    const known = new Set<string>(MODULE_FEATURES);
    for (const article of HELP_ARTICLES) {
      for (const feature of [article.feature, ...(article.covers ?? [])]) {
        if (feature !== null) {
          expect(known.has(feature), `${article.key}: ${feature}`).toBe(true);
        }
      }
    }
  });

  it('names only permissions that exist', () => {
    for (const article of HELP_ARTICLES) {
      if (article.minPermission !== null) {
        expect(isPermission(article.minPermission), article.key).toBe(true);
      }
    }
  });

  it('points only at screens that exist', () => {
    const screens = new Set<string>(NAV_SECTIONS.map((section) => section.path));
    for (const article of HELP_ARTICLES) {
      if (article.appRoute !== null) {
        expect(screens.has(article.appRoute), `${article.key}: ${article.appRoute}`).toBe(true);
      }
    }
  });
});
