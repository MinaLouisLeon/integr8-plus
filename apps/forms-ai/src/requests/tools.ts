import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FoundBrowser } from '../preview/browser.js';
import { loadPicture } from '../mcp/package-files.js';
import { formatError } from '../mcp/report.js';
import { VERSION } from '../version.js';
import type { PreviewWindow } from '../window/preview-window.js';
import { REQUEST_KINDS, requestCode } from './format.js';
import { requestPictures } from './pictures.js';
import {
  findRequest,
  listRequests,
  type RequestExample,
  recordRequest,
  requestsFolder,
  updateRequest,
} from './store.js';

/**
 * The change-request tools (P39). Offline like everything else here: a
 * request is a folder in the output folder, handed over by copying it into
 * the repository's `plan/requests/`.
 */

export interface RequestToolDeps {
  preview: PreviewWindow;
  outputFolder: () => string;
  browser: () => FoundBrowser | undefined;
  scratch: string;
  /** Other names for the list and read tools (the developer MCP server has its own). */
  names?: RequestToolNames;
}

export interface RequestToolNames {
  list?: string;
  get?: string;
}

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const failure = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  isError: true,
});

async function guarded(work: () => Promise<CallToolResult> | CallToolResult) {
  try {
    return await work();
  } catch (error) {
    return failure(formatError(error));
  }
}

const words = z.string().trim().min(1).max(4000);
const answers = z
  .array(
    z.object({
      question: z.string().trim().min(1).max(500),
      answer: z.string().trim().min(1).max(2000),
    }),
  )
  .max(30);

export const HANDOVER =
  'To hand it over, copy the folder into plan/requests/ in the Integr8 Plus repository (or ask an AI tool working in the repository to plan it). Then mark it handed over with update_change_request.';

export function registerRequestTools(server: McpServer, deps: RequestToolDeps): void {
  const root = () => requestsFolder(deps.outputFolder());
  const listName = deps.names?.list ?? 'list_change_requests';
  const getName = deps.names?.get ?? 'get_change_request';

  server.registerTool(
    'record_change_request',
    {
      title: 'Record a change request for the platform',
      description:
        "Writes a change request: something the person wants that the Integr8 Plus platform cannot do yet. Ask first, and only record after they agree: what should happen, for whom, on which apps (web, desktop, phone), and today's workaround. It saves the words, the form and PDF templates being built (from the preview window, even if they do not pass the check yet) and pictures of the Form tab and the PDFs when a browser is available. Never put a real customer's data in a request: use sample answers only.",
      inputSchema: {
        title: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .describe('A short name, e.g. "Mileage claims from a form".'),
        kind: z
          .enum(REQUEST_KINDS)
          .describe('form_format, pdf_design, form_action, app_screen or other.'),
        wanted: words.describe("What should happen, in the person's own words."),
        why: words.describe('Why they need it: the work it is for.'),
        blocked: words.describe("What stopped it: the check's refusal, or what the format lacks."),
        answers: answers.describe(
          'Your questions and their answers (for whom, which apps, workaround…).',
        ),
        example: z
          .enum(['window', 'given', 'none'])
          .optional()
          .describe(
            'The example form: from the open preview window (default when open), the definition given here, or none.',
          ),
        definition: z.record(z.string(), z.unknown()).optional(),
        templates: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              design: z.record(z.string(), z.unknown()),
            }),
          )
          .max(50)
          .optional(),
        pictures: z
          .array(
            z.object({
              id: z.string(),
              path: z.string().optional(),
              base64: z.string().optional(),
            }),
          )
          .max(200)
          .optional()
          .describe('The template pictures, with example "given".'),
        withPictures: z
          .boolean()
          .optional()
          .describe('Picture the Form tab and the PDFs (default true).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        const source =
          input.example ?? (deps.preview.session.content === undefined ? 'none' : 'window');
        let example: RequestExample | undefined;
        if (source === 'window') {
          const content = deps.preview.session.content;
          if (content === undefined) {
            return failure('The preview window holds no form. Use example "given" or "none".');
          }
          example = { ...content };
        } else if (source === 'given') {
          if (input.definition === undefined) {
            return failure('With example "given", pass the form definition.');
          }
          example = {
            definition: input.definition,
            settings: undefined,
            templates: input.templates ?? [],
            pictures: (input.pictures ?? []).map((picture) => loadPicture(picture)),
          };
        }
        const pictured =
          input.withPictures === false || example === undefined
            ? { pictures: [], notes: [] }
            : await requestPictures({
                browser: deps.browser(),
                scratch: deps.scratch,
                example,
                windowUrl: source === 'window' ? await deps.preview.url() : undefined,
              });
        const recorded = recordRequest(root(), {
          title: input.title,
          kind: input.kind,
          wanted: input.wanted,
          why: input.why,
          blocked: input.blocked,
          answers: input.answers,
          example,
          pictures: pictured.pictures,
          madeWith: `Integr8 Forms for AI ${VERSION}`,
        });
        return text(
          [
            `Recorded ${requestCode(recorded.header.number)} "${recorded.header.title}" in ${recorded.folder}`,
            `Files: ${recorded.files.join(', ')}`,
            ...[...recorded.notes, ...pictured.notes].map((note) => `Note: ${note}`),
            '',
            HANDOVER,
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    listName,
    {
      title: 'List the change requests on this computer',
      description:
        'Every change request recorded here, with its number, title, kind, status and date.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(() => {
        const { requests, problems } = listRequests(root());
        const lines = requests.map(
          ({ header }) =>
            `- ${requestCode(header.number)} ${header.title} [${header.kind}, ${header.status}${header.mergedInto === null ? '' : ` into ${requestCode(header.mergedInto)}`}, ${header.date}]`,
        );
        return text(
          [
            lines.length === 0
              ? `No change requests in ${root()}.`
              : `Change requests in ${root()}:`,
            ...lines,
            ...problems.map((problem) => `- (unreadable) ${problem.folder}: ${problem.problem}`),
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    getName,
    {
      title: 'Read one change request',
      description: 'One change request in full: its request.md and the files beside it.',
      inputSchema: { number: z.number().int().min(1).max(9999) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ number }) =>
      guarded(() => {
        const found = findRequest(root(), number);
        return text(
          `${found.folder}\nFiles: ${found.files.join(', ')}\n\n${readFileSync(join(found.folder, 'request.md'), 'utf8')}`,
        );
      }),
  );

  server.registerTool(
    'update_change_request',
    {
      title: 'Change, merge, drop or hand over a change request',
      description:
        'Edits a change request\'s words, merges it into another request (status "merged"), drops it, opens it again, or marks it handed over once its folder is in the repository\'s plan/requests/.',
      inputSchema: {
        number: z.number().int().min(1).max(9999),
        title: z.string().trim().min(3).max(120).optional(),
        kind: z.enum(REQUEST_KINDS).optional(),
        wanted: words.optional(),
        why: words.optional(),
        blocked: words.optional(),
        answers: answers.optional(),
        status: z.enum(['open', 'dropped', 'handed_over']).optional(),
        mergeInto: z.number().int().min(1).max(9999).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(() => {
        if (input.status !== undefined && input.mergeInto !== undefined) {
          return failure('Give a status or mergeInto, not both.');
        }
        const updated = updateRequest(root(), input.number, {
          title: input.title,
          kind: input.kind,
          wanted: input.wanted,
          why: input.why,
          blocked: input.blocked,
          answers: input.answers,
          status: input.status,
          mergeInto: input.mergeInto,
        });
        return text(
          `${requestCode(updated.header.number)} is now ${updated.header.status}${updated.header.mergedInto === null ? '' : ` (merged into ${requestCode(updated.header.mergedInto)})`}: ${updated.folder}`,
        );
      }),
  );
}
