import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FormPackageSettings } from '@integr8/form-package';
import { type Picture, savePackage } from '../mcp/package-files.js';
import {
  type ChangeRequest,
  parseRequest,
  type RequestBody,
  type RequestHeader,
  type RequestKind,
  RequestFormatError,
  type RequestStatus,
  renderRequest,
  requestCode,
  requestFolderName,
} from './format.js';

/**
 * Change requests on this computer (P39): folders under the output folder's
 * `change-requests/`, one per request, numbered in order. Nothing here makes
 * a network request; handing a request over is copying its folder into the
 * repository's `plan/requests/`.
 */

export interface RequestExample {
  definition: unknown;
  settings: Partial<FormPackageSettings> | undefined;
  templates: { name: string; design: unknown }[];
  pictures: Picture[];
}

export interface StoredRequest {
  folder: string;
  header: RequestHeader;
  files: string[];
}

export interface RequestProblemEntry {
  folder: string;
  problem: string;
}

export const requestsFolder = (outputFolder: string) => join(outputFolder, 'change-requests');

const FOLDER = /^CR-(\d{4})-/u;

export function listRequests(root: string): {
  requests: StoredRequest[];
  problems: RequestProblemEntry[];
} {
  const requests: StoredRequest[] = [];
  const problems: RequestProblemEntry[] = [];
  if (!existsSync(root)) {
    return { requests, problems };
  }
  for (const name of readdirSync(root).sort()) {
    if (!FOLDER.test(name)) {
      continue;
    }
    const folder = join(root, name);
    const file = join(folder, 'request.md');
    try {
      const request = parseRequest(readFileSync(file, 'utf8'));
      requests.push({ folder, header: request.header, files: readdirSync(folder).sort() });
    } catch (error) {
      problems.push({
        folder,
        problem: error instanceof RequestFormatError ? error.message : 'request.md is missing.',
      });
    }
  }
  return { requests, problems };
}

function nextNumber(root: string): number {
  if (!existsSync(root)) {
    return 1;
  }
  const taken = readdirSync(root)
    .map((name) => Number(FOLDER.exec(name)?.[1] ?? 0))
    .filter((number) => number > 0);
  return taken.length === 0 ? 1 : Math.max(...taken) + 1;
}

export function findRequest(
  root: string,
  number: number,
): StoredRequest & { request: ChangeRequest } {
  const prefix = `${requestCode(number)}-`;
  const name = existsSync(root)
    ? readdirSync(root).find((entry) => entry.startsWith(prefix))
    : undefined;
  if (name === undefined) {
    throw new Error(`There is no ${requestCode(number)} in ${root}.`);
  }
  const folder = join(root, name);
  const request = parseRequest(readFileSync(join(folder, 'request.md'), 'utf8'));
  return { folder, header: request.header, files: readdirSync(folder).sort(), request };
}

/** Writes the example: the package file, or its JSON when it cannot be packed yet. */
function writeExample(folder: string, example: RequestExample): { file: string; note: string } {
  try {
    savePackage({
      definition: example.definition,
      settings: example.settings,
      templates: example.templates,
      pictures: example.pictures.map((picture) => ({
        id: picture.id,
        base64: Buffer.from(picture.bytes).toString('base64'),
      })),
      fileName: 'example',
      folder,
      overwrite: true,
    });
    return { file: 'example.integr8form', note: '' };
  } catch (error) {
    writeFileSync(
      join(folder, 'example.json'),
      `${JSON.stringify(
        {
          note: 'Could not be packed as a .integr8form yet; kept as JSON.',
          reason: error instanceof Error ? error.message : String(error),
          definition: example.definition,
          settings: example.settings ?? null,
          templates: example.templates,
          pictureIds: example.pictures.map((picture) => picture.id),
        },
        null,
        2,
      )}\n`,
    );
    return {
      file: 'example.json',
      note: `The example could not be packed (${error instanceof Error ? error.message : String(error)}), so it was kept as example.json.`,
    };
  }
}

export interface RecordInput extends RequestBody {
  title: string;
  kind: RequestKind;
  example?: RequestExample | undefined;
  pictures?: readonly { name: string; png: Uint8Array }[] | undefined;
  madeWith: string;
  now?: Date;
}

export interface Recorded {
  folder: string;
  header: RequestHeader;
  files: string[];
  notes: string[];
}

export function recordRequest(root: string, input: RecordInput): Recorded {
  mkdirSync(root, { recursive: true });
  const number = nextNumber(root);
  const folder = join(root, requestFolderName(number, input.title));
  mkdirSync(folder);
  const notes: string[] = [];
  const formTitle = (input.example?.definition as { title?: { en?: unknown } } | undefined)?.title
    ?.en;
  const header: RequestHeader = {
    number,
    title: input.title.trim(),
    date: (input.now ?? new Date()).toISOString().slice(0, 10),
    kind: input.kind,
    status: 'open',
    mergedInto: null,
    form: typeof formTitle === 'string' ? formTitle : null,
    madeWith: input.madeWith,
  };
  if (input.example !== undefined) {
    const written = writeExample(folder, input.example);
    if (written.note !== '') {
      notes.push(written.note);
    }
  }
  for (const picture of input.pictures ?? []) {
    writeFileSync(join(folder, picture.name), picture.png);
  }
  writeFileSync(
    join(folder, 'request.md'),
    renderRequest({
      header,
      wanted: input.wanted,
      why: input.why,
      blocked: input.blocked,
      answers: input.answers,
    }),
  );
  return { folder, header, files: readdirSync(folder).sort(), notes };
}

export interface RequestChange {
  title?: string | undefined;
  kind?: RequestKind | undefined;
  wanted?: string | undefined;
  why?: string | undefined;
  blocked?: string | undefined;
  answers?: { question: string; answer: string }[] | undefined;
  status?: Exclude<RequestStatus, 'merged'> | undefined;
  mergeInto?: number | undefined;
}

export function updateRequest(root: string, number: number, change: RequestChange): StoredRequest {
  const found = findRequest(root, number);
  if (change.mergeInto !== undefined) {
    if (change.mergeInto === number) {
      throw new Error('A request cannot be merged into itself.');
    }
    findRequest(root, change.mergeInto);
  }
  const request: ChangeRequest = {
    header: {
      ...found.request.header,
      ...(change.title === undefined ? {} : { title: change.title.trim() }),
      ...(change.kind === undefined ? {} : { kind: change.kind }),
      ...(change.mergeInto === undefined
        ? change.status === undefined
          ? {}
          : { status: change.status, mergedInto: null }
        : { status: 'merged' as const, mergedInto: change.mergeInto }),
    },
    wanted: change.wanted ?? found.request.wanted,
    why: change.why ?? found.request.why,
    blocked: change.blocked ?? found.request.blocked,
    answers: change.answers ?? found.request.answers,
  };
  const text = renderRequest(request);
  parseRequest(text);
  writeFileSync(join(found.folder, 'request.md'), text);
  let folder = found.folder;
  if (change.title !== undefined) {
    const renamed = join(root, requestFolderName(number, change.title));
    if (renamed !== folder) {
      renameSync(folder, renamed);
      folder = renamed;
    }
  }
  return { folder, header: request.header, files: readdirSync(folder).sort() };
}
