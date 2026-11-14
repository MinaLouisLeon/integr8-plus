import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  checkFormPackage,
  DEFAULT_FILL_ROLES,
  type FormPackageSettings,
} from '@integr8/form-package';
import { z } from 'zod';
import { currentHost, type Host, workDir } from '../host.js';
import { type FoundBrowser, findBrowser } from '../preview/browser.js';
import { outputFolder } from '../settings.js';
import { SERVER_NAME, VERSION } from '../version.js';
import { EXAMPLES, findExample } from './examples.js';
import { GUIDE_SECTIONS, guideContents, guideSection } from './guide.js';
import {
  FileExistsError,
  loadPicture,
  openPackage,
  type PictureInput,
  savePackage,
} from './package-files.js';
import { previewTemplate } from './preview.js';
import { confirmSection, interviewGuide, summarizeForm } from './interview.js';
import { formatCheck, formatError } from './report.js';
import { checkWebsite, formatWebsiteCheck } from '../website/check.js';
import { WEBSITE_GUIDE_SECTIONS, websiteApiText, websiteGuideSection } from '../website/guide.js';
import { nextExampleText, ROUTE_PATTERN } from '../website/nextjs.js';
import { type OpenUrl, systemOpener } from '../window/open-browser.js';
import { PreviewWindow } from '../window/preview-window.js';
import { registerRequestTools, type RequestToolNames } from '../requests/tools.js';

/**
 * The MCP server: the tools an AI coding assistant calls to write a
 * `.integr8form` file, and to add the shared PDF search to a company's
 * Next.js website. Offline by design (decision 15): no tool makes a network
 * request, none holds a credential, and files are read only where the AI
 * passes a path.
 */

export interface ServerOptions {
  host?: Host;
  /** Where previews and opened packages go; the system's temporary folder by default. */
  scratch?: string;
  /** Finds the browser previews print with; tests pass one that finds none. */
  browser?: () => FoundBrowser | undefined;
  /** Opens the preview window in a browser; tests pass one that opens nothing. */
  openUrl?: OpenUrl;
}

export interface FormsToolOptions extends ServerOptions {
  /**
   * Other names for the change-request tools that list and read requests on
   * this computer, for a server that already has tools by those names (the
   * developer MCP server's read the repository's plan/requests/).
   */
  requestToolNames?: RequestToolNames;
}

/** What {@link registerFormsTools} hands back to the server it registered on. */
export interface FormsTools {
  /** Stops the preview window's page server, if one is open. */
  close: () => Promise<void>;
}

/** What the tools are for and how to use them: Forms for AI's own server instructions. */
export const FORMS_INSTRUCTIONS = `Integr8 Forms builds .integr8form files: an Integr8 Plus form (questions, rules, calculations, English and Arabic) with its PDF templates, for Integr8 staff to import.
Build it WITH the person, not for them: before writing anything, call get_interview_guide and ask the person, step by step, about every question you will create (type, English and Arabic label, required, choices, checks, rules, where it prints) and wait for the answers. For every QR code in a PDF template, always ask whether it is the document's share QR code or a fixed link, and what a fixed one opens; never choose for them.
Then: get_format_guide (section "overview"), list_examples/get_example, write the form definition and check it with check_form until it is OK. Add PDF templates and check them with check_package; answer every "To confirm with the person" item by asking. Look at them with preview_pdf. Call summarize_form and show the person the list; save with save_package only after they confirm it. To edit an existing file, open_package it first.
Let the person watch it take shape: once the first version of the form checks OK, call open_preview (it opens a window in their browser with the form as the app shows it and each PDF). After every change, call update_preview with what changed and tell the person the window refreshed. When they say "look at what I typed", "see my note" or similar, call get_preview_state. They may also save from the window.
When the person wants something the platform cannot do (a check refuses an unknown key, question type or block, they press "Suggest a change to the platform" in the window, or they say so), offer: "The platform cannot do this yet. Shall I record it as a change request?" If yes, ask what should happen, for whom, on which apps and what they do today, then call record_change_request. Never put a real customer's data in a request.
Always write every text in both English ("en") and Arabic ("ar").

It also helps add a shared PDF search and download page to a company's own Next.js website, using the company's Integr8 website key: start with get_website_guide, then get_website_api and get_website_example, and check the website with check_website_integration. These tools never call Integr8 and never need the key; never ask the user to paste the key into the chat.`;

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

const settings = z
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
  .optional();

/** The pictures a tool was given, read and checked; undefined when none were given. */
const loadPictures = (pictures: readonly PictureInput[] | undefined) =>
  pictures?.map((entry) => loadPicture(entry));

const settingsOf = (given: z.infer<typeof settings>): Partial<FormPackageSettings> | undefined =>
  given === undefined
    ? undefined
    : {
        ...(given.fillRoles === undefined ? {} : { fillRoles: given.fillRoles }),
        ...(given.signatureRequired === undefined
          ? {}
          : { signatureRequired: given.signatureRequired }),
      };

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
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Integr8 Forms for AI', version: VERSION },
    { instructions: FORMS_INSTRUCTIONS },
  );
  const tools = registerFormsTools(server, options);
  // The window's page server stops with the MCP server.
  const closed = server.server.onclose;
  server.server.onclose = () => {
    closed?.();
    void tools.close();
  };
  return server;
}

/**
 * Registers every Forms for AI tool on a server: this program's own, or the
 * developer MCP server's, which carries them so a developer needs one server
 * (P38). The caller stops the preview window with the returned `close`.
 */
export function registerFormsTools(server: McpServer, options: FormsToolOptions = {}): FormsTools {
  const host = options.host ?? currentHost();
  const scratch = options.scratch ?? workDir(tmpdir());
  const browser = options.browser ?? (() => findBrowser(host));
  const preview = new PreviewWindow({
    scratch,
    browser,
    openUrl: options.openUrl ?? systemOpener(host),
    outputFolder: () => outputFolder(host),
  });

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
          formatCheck(checkFormPackage({ form, templates: templates ?? [], files }), 'package') +
            confirmSection(templates ?? []),
        );
      }),
  );

  server.registerTool(
    'get_interview_guide',
    {
      title: 'Read what to ask the person before building',
      description:
        "The questions to ask the person, step by step, before writing a form or a PDF template: the form as a whole, every question (type, English and Arabic label, required, choices, checks, rules, where it prints), every PDF template, and every QR code (the document's share code, blank until shared, or a fixed link). Call it first, and ask; do not build from a description alone.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(() => text(interviewGuide())),
  );

  server.registerTool(
    'summarize_form',
    {
      title: 'Summarise a form for the person to confirm',
      description:
        'Turns a form definition and its PDF templates into a plain list: every page, section and question with its type, whether it is required, its choices and rules, and every PDF block with what it shows (each QR code as share or fixed, or "not confirmed"). Show it to the person and save only after they confirm it.',
      inputSchema: { definition, templates: z.array(template).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ definition: form, templates }) =>
      guarded(() => text(summarizeForm(form, templates ?? []) + confirmSection(templates ?? []))),
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
        preview.recordAiPrint(input.template, result, {
          useAnswers: false,
          language: input.language,
          companyColour: input.companyColour,
        });
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
        settings,
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
            settings: settingsOf(input.settings),
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

  server.registerTool(
    'open_preview',
    {
      title: 'Open the live preview window',
      description:
        "Opens a window in the person's own browser that shows the form exactly as the app's filler shows it (conditions, calculations, checks, English and Arabic; phone or desktop width) and each PDF template as the server prints it. It refreshes by itself after every update_preview. The page is served by this program on 127.0.0.1 only; nothing leaves the computer. Call it once the first version of the form checks OK. Returns the window's address and the check report.",
      inputSchema: {
        definition,
        settings,
        templates: z.array(template).max(50).optional(),
        pictures: z
          .array(picture)
          .max(200)
          .optional()
          .describe('The pictures the templates use, by id.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(async () => {
        const opened = await preview.open({
          definition: input.definition,
          settings: settingsOf(input.settings),
          templates: input.templates ?? [],
          pictures: loadPictures(input.pictures) ?? [],
        });
        const how = opened.opened
          ? 'The window was opened in the default browser.'
          : opened.openFailed
            ? `The browser could not be opened from here. Ask the person to open this address themselves: ${opened.url}`
            : 'The window was already open and has refreshed.';
        const templates = input.templates ?? [];
        return text(
          `${how}\nWindow: ${opened.url}\nTell the person they can fill the form there, look at each PDF, leave notes for you and save the file. Call update_preview after every change.\n\n${formatCheck(opened.check, templates.length === 0 ? 'form' : 'package')}${confirmSection(templates)}`,
        );
      }),
  );

  server.registerTool(
    'update_preview',
    {
      title: 'Refresh the preview window',
      description:
        'Replaces the form definition, the PDF templates (with their pictures) or the settings shown in the open preview window; parts you leave out stay as they were. The window refreshes without the person reloading, and keeps the answers they typed for questions that still exist with the same type. Returns the check report. Call it after every change, then tell the person the window refreshed.',
      inputSchema: {
        definition: definition.optional(),
        settings,
        templates: z.array(template).max(50).optional(),
        pictures: z.array(picture).max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(() => {
        if (!preview.isOpen) {
          return failure('The preview window is not open; call open_preview first.');
        }
        const check = preview.update({
          ...(input.definition === undefined ? {} : { definition: input.definition }),
          ...(input.settings === undefined ? {} : { settings: settingsOf(input.settings) }),
          ...(input.templates === undefined ? {} : { templates: input.templates }),
          ...(input.pictures === undefined ? {} : { pictures: loadPictures(input.pictures) ?? [] }),
        });
        const templates = preview.session.content?.templates ?? [];
        return text(
          `The window refreshed (version ${String(preview.session.version)}). Tell the person.\n\n${formatCheck(check, templates.length === 0 ? 'form' : 'package')}${confirmSection(templates)}`,
        );
      }),
  );

  server.registerTool(
    'get_preview_state',
    {
      title: 'Read what the person did in the preview window',
      description:
        'What the person did in the open preview window: the answers they typed (by question id), whether they pressed Submit and what the app would have sent, the notes they left for you (each with the tab and the question or template it is about; returned once), which tab they are on, and each PDF print. Call it when the person says "look at what I typed", "see my note" or similar.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(async () => text(await preview.describe())),
  );

  server.registerTool(
    'close_preview',
    {
      title: 'Close the preview window',
      description:
        "Stops the preview window's page server; the page in the browser then says it is disconnected. What the person typed there is forgotten. It also stops by itself when the AI tool closes.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    () =>
      guarded(async () =>
        text(
          (await preview.close())
            ? 'The preview window was closed.'
            : 'The preview window was not open.',
        ),
      ),
  );

  registerRequestTools(server, {
    preview,
    outputFolder: () => outputFolder(host),
    browser,
    scratch,
    ...(options.requestToolNames === undefined ? {} : { names: options.requestToolNames }),
  });

  server.registerTool(
    'get_website_guide',
    {
      title: 'Read the company website guide',
      description:
        'How to add the shared PDF pages to an Integr8 Plus company\'s own Next.js website: the one-box search page and the document page that shared links and QR codes open (/documents/<code>); what the company and Integr8 must switch on, the website key and environment, the security rules the code must keep, and why a search finds nothing. Read "overview" first.',
      inputSchema: {
        section: z
          .enum(WEBSITE_GUIDE_SECTIONS)
          .optional()
          .describe('Which section; "overview" when absent.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ section }) => guarded(() => text(websiteGuideSection(section ?? 'overview'))),
  );

  server.registerTool(
    'get_website_api',
    {
      title: 'Read the website document API',
      description:
        'The exact requests and answers of the Integr8 Plus endpoints a company website uses for shared PDFs: POST /v1/website/documents/lookup (the one search box, `q`, up to ten matches), GET /v1/website/documents/by-code/{code} (the document page shared links open) and GET /v1/website/files/{documentId}, with every field, refusal code and what the website should show for it.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(() => text(websiteApiText())),
  );

  server.registerTool(
    'get_website_example',
    {
      title: 'Get the Next.js document pages',
      description:
        'Ready files for a Next.js (App Router) website: a server-only Integr8 client, the one-box search page (Server Action, form and list of matches with View/Download) and the document page shared links and QR codes open (/documents/[code]), in English and Arabic (right-to-left), and the .env.example lines. Returns them as text with their paths; write them into the project and fit them to its styling and i18n.',
      inputSchema: {
        route: z
          .string()
          .regex(ROUTE_PATTERN)
          .optional()
          .describe(
            'The search page folder under app/, e.g. "certificates" (default) or "[locale]/certificates".',
          ),
        documentRoute: z
          .string()
          .regex(ROUTE_PATTERN)
          .optional()
          .describe(
            'The document page folder under app/ (its [code] folder goes inside): "documents" (default), to match the document link address Integr8 sets, https://<site>/documents/{code}.',
          ),
        srcDir: z.boolean().optional().describe('The project keeps app/ inside src/.'),
        language: z
          .enum(['en', 'ar', 'both'])
          .optional()
          .describe('The page language; "both" (default) reads ?lang=ar.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) =>
      guarded(() =>
        text(
          nextExampleText({
            route: input.route,
            documentRoute: input.documentRoute,
            srcDir: input.srcDir,
            language: input.language,
          }),
        ),
      ),
  );

  server.registerTool(
    'check_website_integration',
    {
      title: "Check a website's Integr8 integration",
      description:
        "Reads a company website's source files (the folders or files you pass; node_modules, .next and the like are skipped) and reports what would leak the website key or break the shared PDF search: a key written in code or in .env.example, a NEXT_PUBLIC_ name, Integr8 called from browser code, an invented endpoint, refusal reasons shown to visitors, cached or stored five-minute links, the key in a log or a response. Read-only; never calls Integr8.",
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe("Absolute paths of the website's folder (best) or of single files."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ paths }) => guarded(() => text(formatWebsiteCheck(checkWebsite(paths)))),
  );

  return {
    close: async () => {
      await preview.close();
    },
  };
}
