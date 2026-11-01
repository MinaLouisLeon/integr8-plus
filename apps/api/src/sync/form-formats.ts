import { compareVersions, parseClientVersion } from '../http/client-version.js';

/**
 * Which apps can open which form definitions (schema version 2, 1.3.0).
 *
 * A definition says in `schemaVersion` which format it needs (see
 * `@integr8/form-engine`'s `requiredSchemaVersion`). An app from 1.3.0 on reads
 * that itself, and asks the engineer to update before opening a form newer
 * than it. An app already in the field before 1.3.0 cannot: given a format 2
 * form it fails to read it and says "This form cannot be shown on this phone.
 * Tell the office it needs checking." — safely, without crashing, but wrongly.
 *
 * So the server marks such forms for those apps, in the one place they will
 * see it before opening one: the form's name, in the job's list of forms and at
 * the top of the form. The definition is still sent, unchanged, so the form
 * opens as soon as the app is updated; the updated app pulls everything again
 * once (`@integr8/offline`'s migration 11), which replaces the marked names.
 */

/** The first app release that reads each definition format newer than 1. */
export const FIRST_APP_READING_FORMAT: Readonly<Record<number, string>> = Object.freeze({
  2: '1.3.0',
});

/**
 * Added to a form's name for an app too old to open it. Both languages: the
 * server does not know which one the phone shows.
 */
export const UPDATE_APP_MARK =
  ' — Update the app to open this form · حدّث التطبيق لفتح هذا النموذج';

/** The format a definition declares, 1 when it says nothing readable. */
export function definitionFormat(definition: Record<string, unknown>): number {
  const declared = definition.schemaVersion;
  return typeof declared === 'number' && Number.isInteger(declared) ? declared : 1;
}

/**
 * Whether an app that declared `clientVersion` can open a definition in
 * `format`. An app that declares no version is served as current, as
 * everywhere else (`assessClientVersion`).
 */
export function appReadsFormat(clientVersion: string | undefined, format: number): boolean {
  const first = FIRST_APP_READING_FORMAT[format];
  const client = parseClientVersion(clientVersion);
  if (format <= 1 || client === undefined) {
    return true;
  }
  const needed = first === undefined ? undefined : parseClientVersion(first);
  // A format with no release named is newer than this server knows of.
  return needed !== undefined && compareVersions(client, needed) >= 0;
}

/** A form's name, marked for an app that cannot open it. */
export function markedTitle(title: string): string {
  return title.endsWith(UPDATE_APP_MARK) ? title : `${title}${UPDATE_APP_MARK}`;
}
