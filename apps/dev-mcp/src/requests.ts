import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.js';

/**
 * The change requests handed over to the repository (P39): `plan/requests/`,
 * each a folder copied from Integr8 Forms for AI (`CR-0007-…/request.md` and
 * its example and pictures) or a note written by hand (`CR-0001-….md`). Read
 * only, so an AI tool following docs/contributing/planning-a-change-request.md
 * finds them without being told paths.
 *
 * Two header styles are read: Forms for AI's table (`| Kind | \`form_action\` |`)
 * and a hand-written note's bold lines (`**Kind:** \`form_action\``). The
 * repository's own status (received, planned, built, declined) is in the
 * README's table and in the request itself.
 */

export const REQUESTS_DIR = join(REPO_ROOT, 'plan', 'requests');

export interface RepoRequest {
  code: string;
  title: string;
  kind: string | null;
  status: string | null;
  /** Where its text is. */
  file: string;
  /** Beside it, for a folder: example and pictures. */
  files: string[];
}

const CODE = /^(CR-\d{4})(?:-|\.|$)/u;

function field(text: string, name: string): string | null {
  const table = new RegExp(`^\\| ${name} \\| (.+?) \\|$`, 'mu').exec(text)?.[1];
  const bold = new RegExp(`^\\*\\*${name}:\\*\\* (.+)$`, 'mu').exec(text)?.[1];
  const raw = table ?? bold;
  if (raw === undefined) {
    return null;
  }
  // The first `code` word, else the text up to a dash.
  return /`([^`]+)`/u.exec(raw)?.[1] ?? raw.split(' — ')[0]?.trim() ?? null;
}

function read(entry: string, folder: string): RepoRequest | undefined {
  const code = CODE.exec(entry)?.[1];
  if (code === undefined) {
    return undefined;
  }
  const path = join(folder, entry);
  const isFolder = statSync(path).isDirectory();
  const file = isFolder ? join(path, 'request.md') : path;
  if (!existsSync(file) || (!isFolder && !entry.endsWith('.md'))) {
    return undefined;
  }
  const text = readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
  return {
    code,
    title: /^# CR-\d{4} — (.+)$/mu.exec(text)?.[1]?.trim() ?? entry,
    kind: field(text, 'Kind'),
    status: field(text, 'Status'),
    file,
    files: isFolder ? readdirSync(path).sort() : [],
  };
}

export function listRepoRequests(folder: string = REQUESTS_DIR): RepoRequest[] {
  if (!existsSync(folder)) {
    return [];
  }
  return readdirSync(folder)
    .sort()
    .flatMap((entry) => read(entry, folder) ?? []);
}

/** One request by its code (`CR-0001`) or number, with its full text. */
export function getRepoRequest(
  which: string | number,
  folder: string = REQUESTS_DIR,
): (RepoRequest & { text: string }) | undefined {
  const code =
    typeof which === 'number' ? `CR-${String(which).padStart(4, '0')}` : which.toUpperCase().trim();
  const found = listRepoRequests(folder).find((request) => request.code === code);
  return found === undefined ? undefined : { ...found, text: readFileSync(found.file, 'utf8') };
}
