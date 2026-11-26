import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The web app is the public site only (P42): the office works in the company
 * desktop apps and staff in the staff app. This pins every page and route
 * handler it serves, so a workspace, dashboard, sign-in or sign-up route
 * cannot come back unnoticed. It serves no company's documents, quotes or
 * asset tags either: those open on the company's own website. Its features
 * and pricing pages are gone too: the product is presented, with no prices, on
 * the Integr8 Media website. Change the list on purpose.
 */

const PUBLIC_ROUTES = [
  '/',
  '/accept-invitation',
  '/contact',
  '/desktop-updates/[app]/[target]/[arch]/[version]',
  '/desktop-updates/[app]/download/[tag]/[file]',
  '/download',
  '/help',
  '/legal/dpa',
  '/legal/privacy',
  '/legal/terms',
];

const app = fileURLToPath(new URL('.', import.meta.url));

function routes(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(folder)) {
    const path = join(folder, entry);
    if (statSync(path).isDirectory()) {
      found.push(...routes(path));
    } else if (/^(page|route)\.tsx?$/u.test(entry)) {
      const route = relative(app, folder).split(sep).join('/');
      found.push(`/${route}`.replace(/\/$/u, '') || '/');
    }
  }
  return found;
}

describe('the public site’s routes', () => {
  it('are exactly the pinned list', () => {
    expect(routes(app).sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});
