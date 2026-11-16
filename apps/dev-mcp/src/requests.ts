import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { repositoryRoot } from './paths.js';

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

/**
 * The repository's plan/requests/, or undefined when the installed program
 * has not been told where integr8-plus is (P43).
 */
export function requestsDir(): string | undefined {
  const root = repositoryRoot();
  return root === undefined ? undefined : join(root, 'plan', 'requests');
}

/** Said when there is no repository to read or write change requests in. */
export const NO_REPOSITORY =
  'This program does not know where your integr8-plus folder is, so it has no plan/requests/. Give the folder once as `repository` (the absolute path of your integr8-plus checkout).';

function folderOrThrow(folder: string | undefined): string {
  const found = folder ?? requestsDir();
  if (found === undefined) {
    throw new Error(NO_REPOSITORY);
  }
  return found;
}

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

export function listRepoRequests(given?: string): RepoRequest[] {
  const folder = folderOrThrow(given);
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
  given?: string,
): (RepoRequest & { text: string }) | undefined {
  const code =
    typeof which === 'number' ? `CR-${String(which).padStart(4, '0')}` : which.toUpperCase().trim();
  const found = listRepoRequests(given).find((request) => request.code === code);
  return found === undefined ? undefined : { ...found, text: readFileSync(found.file, 'utf8') };
}

/**
 * Adds a handed-over request's row to plan/requests/README.md, status
 * `received`, after the table's last row. Returns false when the README or its
 * table is not there (the request is still handed over; the row is written by
 * hand). The table's columns are aligned again by Prettier afterwards.
 */
export function addReadmeRow(
  entry: { code: string; folder: string; title: string; kind: string },
  given?: string,
): boolean {
  const readme = join(folderOrThrow(given), 'README.md');
  if (!existsSync(readme)) {
    return false;
  }
  const original = readFileSync(readme, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/u);
  const heading = lines.findIndex((line) => line.trim() === '## Requests');
  if (heading === -1) {
    return false;
  }
  let last = -1;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('## ')) {
      break;
    }
    if (line.startsWith('|')) {
      last = index;
    } else if (last !== -1 && line.trim() !== '') {
      break;
    }
  }
  if (last === -1) {
    return false;
  }
  const title = entry.title.replace(/\|/gu, '\\|');
  const row = `| [${entry.code}](${basename(entry.folder)}/request.md) ${title} | \`${entry.kind}\` | \`received\` | — |`;
  lines.splice(last + 1, 0, row);
  writeFileSync(readme, lines.join(newline));
  return true;
}
