import { readFileSync } from 'node:fs';

/**
 * The tool's version: the product's, from the root package.json, because the
 * tool is released with the app (decision 15) and a tool and a server of the
 * same version always agree on the file format.
 *
 * The bundle has it written in at build time (`scripts/bundle.mjs` defines
 * `__FORMS_AI_VERSION__`, the release workflow passes the release's own
 * version); run from source, it is read from the repository's package.json,
 * so there is no second copy to keep in step.
 */

declare const __FORMS_AI_VERSION__: string | undefined;

function sourceVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION: string =
  typeof __FORMS_AI_VERSION__ === 'string' ? __FORMS_AI_VERSION__ : sourceVersion();

/** The name AI tools know the server by, in every configuration it writes. */
export const SERVER_NAME = 'integr8-forms';

/** The program's file name, without the `.exe` Windows adds. */
export const PROGRAM_NAME = 'integr8-forms-ai';
