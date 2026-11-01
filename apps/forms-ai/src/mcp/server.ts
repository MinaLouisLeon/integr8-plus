import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { checkFormPackage, DEFAULT_FILL_ROLES } from '@integr8/form-package';
import { z } from 'zod';
import { currentHost, type Host, workDir } from '../host.js';
import { type FoundBrowser, findBrowser } from '../preview/browser.js';
import { outputFolder } from '../settings.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { EXAMPLES, findExample } from './examples.js';
import { GUIDE_SECTIONS, guideContents, guideSection } from './guide.js';
import { FileExistsError, openPackage, savePackage } from './package-files.js';
import { previewTemplate } from './preview.js';
import { formatCheck, formatError } from './report.js';

/**
 * The MCP server: the tools an AI coding assistant calls to write a
 * `.integr8form` file. Offline by design (decision 15): no tool makes a
 * network request, none holds a credential, and files are read only where
 * the AI passes a path.
 */

export interface ServerOptions {
  host?: Host;
  /** Where previews and opened packages go; the system's temporary folder by default. */
  scratch?: string;
  /** Finds the browser previews print with; tests pass one that finds none. */
  browser?: () => FoundBrowser | undefined;
}

const INSTRUCTIONS = `Integr8 Forms builds .integr8form files: an Integr8 Plus form (questions, rules, calculations, English and Arabic) with its PDF templates, for Integr8 staff to import.
Start with get_format_guide (section "overview"), look at list_examples/get_example, then write the form definition and check it with check_form until it is OK. Add PDF templates and check them with check_package; look at them with preview_pdf. Save with save_package. To edit an existing file, open_package it first.
Always write every text in both English ("en") and Arabic ("ar").`;

const definition = z
  .record(z.string(), z.unknown())
  .describe(
    'The form definition JSON: { schemaVersion, title: {en, ar}, pages: [...] }. See get_format_guide.',
  );

const template = z.object({
  name: z
    .string()
    .min(1)
    .max(120)
    .describe('The template\'s name, e.g. "Service certificate" (1–120 characters).'),
  design: z
    .record(z.string(), z.unknown())
    .describe(
      'The PDF template design JSON: { schemaVersion: 2, page, style, fields, blocks }. See get_format_guide section "pdf_templates".',
    ),
});

const picture = z.object({
  id: z
    .string()
    .describe(
      'The picture\'s id: the lowercase UUID the design uses as "fileId" (get fresh ones from new_picture_ids).',
    ),
  path: z.string().optional().describe('Absolute path of a local PNG, JPEG or WebP file.'),
  base64: z.string().optional().describe("Or the picture's bytes as base64 (instead of path)."),
});

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const failure = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  isError: true,
});

async function guarded(
  work: () => Promise<CallToolResult> | CallToolResult,
): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    return failure(formatError(error));
  }
}

export function createFormsServer(options: ServerOptions = {}): McpServer {
  const host = options.host ?? currentHost();
  const scratch = options.scratch ?? workDir(tmpdir());
  const browser = options.browser ?? (() => findBrowser(host));

  const server = new McpServer(
    { name: SERVER_NAME, title: 'Integr8 Forms for AI', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'get_format_guide',
    {
      title: 'Read the Integr8 form format guide',
      description:
        'The Integr8 Plus form and PDF template format, generated from the real schemas: question types with every option, rules (shown when, required when, checks, cascading choices), calculations (numbers, dates, times), repeating sections, Information blocks, English+Arabic rules, PDF template blocks/placeholders/header/footer/look/fonts/landscape, limits, and JSON Schemas. Read "overview" first.',
      inputSchema: {
        section: z
          .enum(GUIDE_SECTIONS)
          .optional()
          .describe('Which section; "overview" when absent. "json_schema" is long.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ section }) =>
      guarded(() => {
        const chosen = section ?? 'overview';
        return text(
          chosen === 'overview'
            ? `${guideSection('overview')}\n${guideContents()}`
            : guideSection(chosen),
        );
      }),
  );

  server.registerTool(
    'list_examples',
    {
      title: 'List example forms and PDF templates',
      description:
        'Lists complete, valid examples: the six forms of the Integr8 template library, a form using every 1.3.0 feature, and PDF templates that print them. Read one with get_example.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(() =>
        text(
          EXAMPLES.map((example) =>
            example.kind === 'form'
              ? `- ${example.key} (form) — ${example.title.en ?? ''} / ${example.title.ar ?? ''}: ${example.description}`
              : `- ${example.key} (PDF template for the form "${example.form}") — ${example.name}: ${example.description}`,
          ).join('\n'),
        ),
      ),
  );

  server.registerTool(
    'get_example',
    {
      title: 'Read one example',
      description:
        "Returns one example as JSON: a form's definition, or a PDF template's design together with the key of the form it prints.",
      inputSchema: { key: z.string().describe('An example key from list_examples.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ key }) =>
      guarded(() => {
        const example = findExample(key);
        if (example === undefined) {
          return failure(
            `No example "${key}". Keys: ${EXAMPLES.map((entry) => entry.key).join(', ')}.`,
          );
        }
        return text(
          JSON.stringify(
            example.kind === 'form'
              ? { key: example.key, kind: example.kind, definition: example.definition }
              : {
                  key: example.key,
                  kind: example.kind,
                  form: example.form,
                  name: example.name,
                  design: example.design,
                },
            null,
            2,
          ),
        );
      }),
  );

  server.registerTool(
    'new_picture_ids',
    {
      title: 'Make picture ids',
      description:
        'Fresh lowercase UUIDs to name the pictures a PDF template uses (backgrounds and image blocks: "fileId"). Pass the same ids with the picture files to check_package, preview_pdf and save_package.',
      inputSchema: {
        count: z.number().int().min(1).max(20).optional().describe('How many (default 1).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ count }) =>
      guarded(() => text(Array.from({ length: count ?? 1 }, () => randomUUID()).join('\n'))),
  );

  server.registerTool(
    'check_form',
    {
      title: 'Check a form definition',
      description:
        'Checks a form definition with the same compile Integr8 Plus runs before publishing: structure, ids, option values, rule and calculation types, references, cycles, schema version. Lists every problem with its JSON path and code, and warnings such as missing Arabic or English. Fix and check again until it is OK.',
      inputSchema: { definition },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ definition: form }) => guarded(() => text(formatCheck(checkFormPackage({ form }), 'form'))),
  );

  server.registerTool(
    'check_package',
    {
      title: 'Check a form with its PDF templates',
      description:
        'Checks a form definition, its PDF templates and their pictures as Integr8 Plus would on import and publish: the form compile, each design against the form (questions exist, are of a kind the block can show, are inside/outside repeating sections as needed), and that every picture a design uses is given and every picture given is used.',
      inputSchema: {
        definition,
        templates: z.array(template).max(50).optional(),
        pictures: z
          .array(picture)
          .max(200)
          .optional()
          .describe('The pictures the templates use, by id.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ definition: form, templates, pictures }) =>
      guarded(() => {
        const files = (pictures ?? []).map((entry) => ({ id: entry.id }));
        return text(
          formatCheck(checkFormPackage({ form, templates: templates ?? [], files }), 'package'),
        );
      }),
  );

  server.registerTool(
    'preview_pdf',
    {
      title: 'Preview a PDF template',
      description:
        "Prints one PDF template for the form with sample answers (or the answers you give), exactly as the Integr8 Plus server prints it, using Chrome/Edge/Chromium on this computer. Returns the PDF's path and images of the first pages so you can see the layout. Without a browser it says so and only checks. Company details are stand-ins (Sample Company, job WO-1042, a grey LOGO box).",
      inputSchema: {
        definition,
        template,
        answers: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Answers by question id (repeating sections: [{ "id": "e1", "values": {...} }]); merged over generated sample answers.',
          ),
        pictures: z
          .array(picture)
          .max(200)
          .optional()
          .describe("The template's own pictures (backgrounds, image blocks)."),
        answerPictures: z
          .record(z.string(), z.array(z.string()).max(10))
          .optional()
          .describe(
            'Sample photos or signatures: question id → absolute paths of PNG/JPEG/WebP files.',
          ),
        typedFields: z
          .record(z.string(), z.string())
          .optional()
          .describe("Values for the template's typed document fields, by key."),
        language: z
          .enum(['en', 'ar'])
          .optional()
          .describe("Print in English or Arabic (default: the template's language, else English)."),
        companyColour: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/u)
          .optional()
          .describe('The company accent colour used for brandColour "company".'),
        pages: z
          .number()
          .int()
          .min(1)
          .max(6)
          .optional()
          .describe('How many page images to return (default 2).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        const result = await previewTemplate(
          {
            definition: input.definition,
            template: input.template,
            answers: input.answers,
            pictures: input.pictures,
            answerPictures: input.answerPictures,
            typedFields: input.typedFields,
            language: input.language,
            companyColour: input.companyColour,
            pages: input.pages,
          },
          { browser: browser(), scratch },
        );
        const lines = [
          result.pdfPath === undefined
            ? `No preview: ${result.skipped ?? 'nothing to print.'}`
            : `Printed ${String(result.pageCount ?? 0)} page(s): ${result.pdfPath}\nPage images: ${result.pageImages.map((page) => page.path).join(', ')}`,
          ...result.notes.map((note) => `Note: ${note}`),
          '',
          formatCheck(result.check, 'package'),
        ];
        return {
          content: [
            { type: 'text', text: lines.join('\n') },
            ...result.pageImages.map((page) => ({
              type: 'image' as const,
              data: Buffer.from(page.png).toString('base64'),
              mimeType: 'image/png',
            })),
          ],
        };
      }),
  );

  server.registerTool(
    'save_package',
    {
      title: 'Save the .integr8form file',
      description:
        'Packs the form definition, its settings, PDF templates and pictures into one .integr8form file in the output folder (default: Documents/Integr8 forms, set in the installer) and returns its path with the check result. Refuses to replace an existing file unless "overwrite" is true — ask the user first.',
      inputSchema: {
        definition,
        settings: z
          .object({
            fillRoles: z
              .array(
                z.enum([
                  'owner',
                  'admin',
                  'hr_manager',
                  'inventory_manager',
                  'dispatcher',
                  'engineer',
                  'viewer',
                ]),
              )
              .optional()
              .describe(`Who may fill the form (default ${DEFAULT_FILL_ROLES.join(', ')}).`),
            signatureRequired: z
              .boolean()
              .optional()
              .describe('A job using the form needs a signature before it closes (default false).'),
          })
          .optional(),
        templates: z.array(template).max(50).optional(),
        pictures: z.array(picture).max(200).optional(),
        fileName: z
          .string()
          .max(120)
          .optional()
          .describe("File name without extension; default: the form's English title."),
        folder: z
          .string()
          .optional()
          .describe('Absolute folder to save in, only if the user asked for a different place.'),
        overwrite: z.boolean().optional().describe('Replace an existing file of the same name.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      guarded(() => {
        try {
          const saved = savePackage({
            definition: input.definition,
            settings:
              input.settings === undefined
                ? undefined
                : {
                    ...(input.settings.fillRoles === undefined
                      ? {}
                      : { fillRoles: input.settings.fillRoles }),
                    ...(input.settings.signatureRequired === undefined
                      ? {}
                      : { signatureRequired: input.settings.signatureRequired }),
                  },
            templates: input.templates,
            pictures: input.pictures,
            fileName: input.fileName,
            folder: input.folder ?? outputFolder(host),
            overwrite: input.overwrite,
          });
          return text(
            `${saved.replaced ? 'Replaced' : 'Saved'} ${saved.path} (${String(saved.bytes)} bytes). Integr8 staff import it from the Forms page (as a new draft) or the dashboard's Templates page.\n\n${formatCheck(saved.check, 'package')}`,
          );
        } catch (error) {
          if (error instanceof FileExistsError) {
            return failure(error.message);
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    'open_package',
    {
      title: 'Open a .integr8form file',
      description:
        'Reads an existing .integr8form file (exported from Integr8 Plus or saved earlier) for editing: returns its form definition, settings, PDF templates, and its pictures written to a temporary folder with their paths and ids, plus the check result. Edit, then save_package with the same pictures.',
      inputSchema: { path: z.string().describe('Absolute path of the .integr8form file.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ path }) =>
      guarded(() => {
        const opened = openPackage(path, scratch);
        return text(
          `Opened ${path}. Pictures were written to ${opened.folder}.\n\n${formatCheck(opened.check, 'package')}\n\nContents:\n${JSON.stringify(
            {
              createdBy: opened.manifest.createdBy,
              source: opened.manifest.form.source,
              definition: opened.definition,
              settings: opened.settings,
              templates: opened.templates,
              pictures: opened.pictures,
            },
            null,
            2,
          )}`,
        );
      }),
  );

  return server;
}
