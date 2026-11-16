import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { failure, text } from '@integr8/forms-ai/tools';
import { z } from 'zod';
import type { ApiAnswer, Person } from './connection.js';
import {
  ENV_API_URL,
  ENV_WEBSITE_KEY,
  envFileProblem,
  envNameProblem,
  writeEnvValues,
} from './envfile.js';
import { checkRequest, type RouteIndex } from './openapi.js';
import { testPdf } from './pdf.js';
import { redact } from './redact.js';
import type { DevContext } from './server.js';
import type { StoredWebsiteKey, WebsiteKeyVault } from './store.js';

/**
 * Building a company's website against a test company (P43).
 *
 * A company's website lives in its own repository and reaches Integr8 only
 * through `/v1/website`, with a website key, from its server. These tools set
 * a test company up for that (a key, Integr8's grants, the company's own
 * switches, the website's address and the document link pattern), send
 * requests exactly as the website's server would, and make shared documents
 * with known values for its search page to find. The key never reaches the
 * AI: it is kept where the staff session is, and written straight into the
 * website's `.env.local` when asked.
 */

export interface WebsiteToolDeps {
  routes: RouteIndex;
  guarded: (work: (context: DevContext) => Promise<CallToolResult>) => Promise<CallToolResult>;
  needCompany: () => { id: string; name: string; slug: string };
  describeAnswer: (answer: ApiAnswer, extra?: string[]) => string;
}

const COMPANY: Person = { key: 'company', label: 'company' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** How long seeding waits for the worker to print a made document. */
const PRINT_WAIT_MS = 90_000;

interface KeySummary {
  id: string;
  hint: string;
  label: string | null;
  enabled: boolean;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lookups: number;
  found: number;
}

interface DocumentBody {
  id: string;
  title: string;
  status: 'pending' | 'ready' | 'failed';
  failureCode: string | null;
  shareable: boolean;
  linkOpens: boolean;
  link: string | null;
  publicCode: string;
  reference: string | null;
  fields: { key: string; label: { en?: string } | string; value: string; lookupRole?: string }[];
}

const vaultOf = (context: DevContext): WebsiteKeyVault => {
  if (context.websiteKeys === undefined) {
    throw new Error('This server keeps no website keys here.');
  }
  return context.websiteKeys;
};

const keyLine = (key: KeySummary, stored: boolean) =>
  `- ${key.id} …${key.hint}${key.label === null ? '' : ` "${key.label}"`}: ${key.revokedAt !== null ? 'revoked' : key.enabled ? 'live' : 'disabled'}, ${String(key.lookups)} lookups, ${String(key.found)} found, last used ${key.lastUsedAt ?? 'never'}${stored ? ' (kept here for call_website_api)' : ''}`;

export function registerWebsiteTools(server: McpServer, deps: WebsiteToolDeps): void {
  const { routes, guarded, needCompany, describeAnswer } = deps;

  const listKeys = async (context: DevContext, tenantId: string): Promise<KeySummary[]> => {
    const answer = await context.connection.staff({
      method: 'GET',
      path: `/v1/platform/companies/${tenantId}/website-keys`,
    });
    if (answer.status !== 200) {
      throw new Error(`Listing website keys failed:\n${describeAnswer(answer)}`);
    }
    return (answer.body as { items: KeySummary[] }).items;
  };

  /** The stored key to send: the one named, or the newest still live. */
  const keyToSend = async (
    context: DevContext,
    tenantId: string,
    keyId: string | undefined,
  ): Promise<StoredWebsiteKey> => {
    const stored = await vaultOf(context).list(tenantId);
    const chosen =
      keyId === undefined
        ? stored.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        : stored.find((key) => key.keyId === keyId);
    if (chosen === undefined) {
      throw new Error(
        keyId === undefined
          ? 'No website key is kept here for this company. Make one with create_website_key.'
          : `Key ${keyId} is not kept here (only keys made with create_website_key are). See list_website_keys.`,
      );
    }
    return chosen;
  };

  const writeEnv = (
    context: DevContext,
    key: StoredWebsiteKey,
    envFile: string,
    keyName: string,
    urlName: string,
  ): string => {
    writeEnvValues(envFile, { [keyName]: key.secret, [urlName]: context.connection.api });
    return `Wrote ${keyName} (key …${key.hint}) and ${urlName}=${context.connection.api} to ${envFile}. Restart the website's dev server so it reads them.`;
  };

  const envInput = {
    envFile: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "Absolute path of the website's .env.local: the key is written there (never shown to you), with the API address.",
      ),
    keyName: z.string().max(64).optional().describe(`Default ${ENV_WEBSITE_KEY}.`),
    urlName: z.string().max(64).optional().describe(`Default ${ENV_API_URL}.`),
  };

  const envProblems = (input: {
    envFile?: string | undefined;
    keyName?: string | undefined;
    urlName?: string | undefined;
  }) =>
    [
      input.envFile === undefined ? undefined : envFileProblem(input.envFile),
      envNameProblem(input.keyName ?? ENV_WEBSITE_KEY),
      envNameProblem(input.urlName ?? ENV_API_URL),
    ].filter((problem): problem is string => problem !== undefined);

  server.registerTool(
    'create_website_key',
    {
      title: 'Make a website key for the test company',
      description:
        "Makes a website key for the chosen test company (needs a staff manager's sign-in; at most two live at a time) and keeps it here, so call_website_api can send it. The key is never shown: give envFile (the website's .env.local, absolute path) and it is written there with the API address, under the names the website guide uses. Without envFile, write it later with write_website_env.",
      inputSchema: {
        label: z.string().trim().min(1).max(80).optional(),
        ...envInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const problems = envProblems(input);
        if (problems.length > 0) {
          return failure(problems.join('\n'));
        }
        const answer = await context.connection.staff({
          method: 'POST',
          path: `/v1/platform/companies/${chosen.id}/website-keys`,
          body: { label: input.label ?? 'Developer MCP' },
        });
        if (answer.status !== 201) {
          return failure(`The key was not made:\n${describeAnswer(answer)}`);
        }
        const made = answer.body as { key: KeySummary & { createdAt: string }; secret: string };
        const stored: StoredWebsiteKey = {
          tenantId: chosen.id,
          keyId: made.key.id,
          hint: made.key.hint,
          label: made.key.label,
          secret: made.secret,
          createdAt: made.key.createdAt,
        };
        await vaultOf(context).put(stored);
        return text(
          [
            `Made key ${made.key.id} (…${made.key.hint}) for ${chosen.name}; kept here for call_website_api.`,
            input.envFile === undefined
              ? 'Not written to any file: call write_website_env with the website’s .env.local to use it there.'
              : writeEnv(
                  context,
                  stored,
                  input.envFile,
                  input.keyName ?? ENV_WEBSITE_KEY,
                  input.urlName ?? ENV_API_URL,
                ),
            'Next: set_website_access, then seed_shared_documents.',
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    'write_website_env',
    {
      title: "Write a kept website key into the website's .env.local",
      description:
        "Writes a website key kept here (the newest, or the one named) and the API address into the website's .env.local, replacing the lines that already name them and keeping the rest. The key is never shown.",
      inputSchema: {
        keyId: z.string().regex(UUID).optional(),
        envFile: z
          .string()
          .min(1)
          .max(1000)
          .describe(envInput.envFile.description ?? ''),
        keyName: envInput.keyName,
        urlName: envInput.urlName,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const problems = envProblems(input);
        if (problems.length > 0) {
          return failure(problems.join('\n'));
        }
        const key = await keyToSend(context, chosen.id, input.keyId);
        return text(
          writeEnv(
            context,
            key,
            input.envFile,
            input.keyName ?? ENV_WEBSITE_KEY,
            input.urlName ?? ENV_API_URL,
          ),
        );
      }),
  );

  server.registerTool(
    'list_website_keys',
    {
      title: 'List the test company’s website keys',
      description:
        'Every website key of the chosen test company, revoked ones too: its last characters, state, how often the website used it and when, and whether it is kept here (only those can be sent by call_website_api).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guarded(async (context) => {
        const chosen = needCompany();
        const [keys, stored] = await Promise.all([
          listKeys(context, chosen.id),
          vaultOf(context).list(chosen.id),
        ]);
        const kept = new Set(stored.map((key) => key.keyId));
        return text(
          keys.length === 0
            ? `${chosen.name} has no website key. Make one with create_website_key.`
            : keys.map((key) => keyLine(key, kept.has(key.id))).join('\n'),
        );
      }),
  );

  server.registerTool(
    'revoke_website_key',
    {
      title: 'Revoke a website key',
      description:
        'Revokes one of the test company’s website keys (a website using it stops at once) and forgets it here. It stays listed, revoked.',
      inputSchema: { keyId: z.string().regex(UUID) },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    ({ keyId }) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const answer = await context.connection.staff({
          method: 'POST',
          path: `/v1/platform/companies/${chosen.id}/website-keys/${keyId}/revoke`,
        });
        if (answer.status === 200 || answer.status === 404) {
          await vaultOf(context).remove(chosen.id, keyId);
        }
        return answer.status === 200
          ? text(`Revoked ${keyId}; no longer kept here.`)
          : failure(describeAnswer(answer));
      }),
  );

  server.registerTool(
    'set_website_access',
    {
      title: 'Switch the test company’s website access on, and set its website',
      description:
        "Sets what a company website needs, in one call: Integr8's grants (documents and website_files, plus jobs, quotes, invoices if asked), the company's own matching switches (as the company), the website's address and the document link pattern (a test company may use http://localhost:<port>, so a test document's QR code opens the site being built). Only what is given changes; reports each step.",
      inputSchema: {
        files: z
          .boolean()
          .optional()
          .describe('Documents: Integr8’s grant and the company switch.'),
        jobs: z.boolean().optional(),
        quotes: z.boolean().optional(),
        invoices: z.boolean().optional(),
        websiteUrl: z
          .string()
          .max(2048)
          .nullable()
          .optional()
          .describe('e.g. http://localhost:3000; null removes it.'),
        documentLinkPattern: z
          .string()
          .max(500)
          .nullable()
          .optional()
          .describe(
            'e.g. http://localhost:3000/documents/{code}; null sends links back to Integr8’s page.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const steps: string[] = [];
        let failed = false;
        const record = (label: string, answer: ApiAnswer, ok: number) => {
          if (answer.status === ok) {
            steps.push(`- ${label}: done`);
          } else {
            failed = true;
            steps.push(`- ${label}: ${describeAnswer(answer).split('\n').join('\n  ')}`);
          }
        };
        const grants: [string, boolean | undefined][] = [
          ['documents', input.files === true ? true : undefined],
          ['website_files', input.files],
          ['website_jobs', input.jobs],
          ['website_quotes', input.quotes],
          ['website_invoices', input.invoices],
        ];
        for (const [flag, enabled] of grants) {
          if (enabled === undefined) {
            continue;
          }
          record(
            `Integr8's ${flag} ${enabled ? 'on' : 'off'}`,
            await context.connection.staff({
              method: 'PUT',
              path: `/v1/platform/companies/${chosen.id}/flags/${flag}`,
              body: { enabled },
            }),
            200,
          );
        }
        const switches = {
          ...(input.files === undefined ? {} : { websiteFilesEnabled: input.files }),
          ...(input.jobs === undefined ? {} : { websiteJobsEnabled: input.jobs }),
          ...(input.quotes === undefined ? {} : { websiteQuotesEnabled: input.quotes }),
          ...(input.invoices === undefined ? {} : { websiteInvoicesEnabled: input.invoices }),
        };
        if (Object.keys(switches).length > 0) {
          record(
            `The company's own switches (${Object.keys(switches).join(', ')})`,
            await context.connection.as({
              tenantId: chosen.id,
              person: COMPANY,
              purpose: 'switching website access on for a website being built',
              method: 'PATCH',
              path: '/v1/settings/website-access',
              body: switches,
            }),
            200,
          );
        }
        const settings = {
          ...(input.websiteUrl === undefined ? {} : { websiteUrl: input.websiteUrl }),
          ...(input.documentLinkPattern === undefined
            ? {}
            : { documentLinkPattern: input.documentLinkPattern }),
        };
        if (Object.keys(settings).length > 0) {
          record(
            `Website and links (${Object.keys(settings).join(', ')})`,
            await context.connection.staff({
              method: 'PATCH',
              path: `/v1/platform/companies/${chosen.id}/settings`,
              body: settings,
            }),
            200,
          );
        }
        if (steps.length === 0) {
          return failure(
            'Nothing to change: give files, jobs, quotes, invoices, websiteUrl or documentLinkPattern.',
          );
        }
        const result = `${chosen.name}:\n${steps.join('\n')}`;
        return failed ? failure(result) : text(result);
      }),
  );

  server.registerTool(
    'call_website_api',
    {
      title: 'Call /v1/website as the company’s website would',
      description:
        "Sends one request to a /v1/website route (the document lookup and by-code, jobs, quotes, invoices, files) with the test company's website key kept here, and nothing else: no person and no impersonation grant, exactly what the website's server sends. Checks the request against the route first. Returns the answer (signed file links hidden) and the key's use afterwards.",
      inputSchema: {
        method: z.enum(['GET', 'POST']),
        path: z
          .string()
          .min(1)
          .max(500)
          .describe('A concrete path, e.g. /v1/website/documents/by-code/<code>.'),
        query: z.record(z.string(), z.unknown()).optional(),
        body: z.unknown().optional(),
        keyId: z.string().regex(UUID).optional().describe('Default: the newest key kept here.'),
        skipCheck: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const path = input.path.split('?')[0] ?? '';
        const route = routes.find({ method: input.method, path });
        if (route === undefined) {
          return failure(`No route ${input.method} ${path}. See find_route.`);
        }
        if (route.security !== 'website_key') {
          return failure(
            `${route.operationId} is not a website route (it does not take a website key). Use call_api.`,
          );
        }
        const query = input.query ?? {};
        if (input.skipCheck !== true) {
          const problems = checkRequest(route, { path, query, body: input.body });
          if (problems.length > 0) {
            return failure(
              `Not sent: the request does not fit ${route.operationId}.\n${problems.map((problem) => `- ${problem.where}: ${problem.message}`).join('\n')}`,
            );
          }
        }
        const key = await keyToSend(context, chosen.id, input.keyId);
        const answer = await context.connection.request({
          as: `website (key …${key.hint})`,
          method: input.method,
          path,
          query,
          ...(input.body === undefined ? {} : { body: input.body }),
          token: key.secret,
        });
        const after = (await listKeys(context, chosen.id).catch(() => [])).find(
          (candidate) => candidate.id === key.keyId,
        );
        return text(
          describeAnswer(answer, [
            after === undefined
              ? 'Key use: could not be read.'
              : `Key use now: ${String(after.lookups)} lookups, ${String(after.found)} found, last used ${after.lastUsedAt ?? 'never'}.`,
          ]),
        );
      }),
  );

  const typedField = z.object({
    label: z.string().trim().min(1).max(60),
    value: z.string().trim().min(1).max(500),
  });

  server.registerTool(
    'seed_shared_documents',
    {
      title: 'Make shared documents for the website to find',
      description:
        "Makes documents in the chosen test company's register and shares them, so a website's search and document pages have known values to find. `uploaded`: a one-page PDF made here naming its values, uploaded with a reference and up to 10 typed fields (both searchable). `made`: printed from a submitted submission with one of its form's PDF templates (submit_form first); waits up to 90 s for the worker to print it. Set shared: false for one the website must not find. Returns each document's code, link and searchable values.",
      inputSchema: {
        documents: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('uploaded'),
                title: z.string().trim().min(1).max(200),
                reference: z.string().trim().min(1).max(100),
                fields: z.array(typedField).max(10).optional(),
                shared: z.boolean().optional(),
                expiresAt: z.iso.datetime().optional(),
              }),
              z.object({
                kind: z.literal('made'),
                submissionId: z.string().regex(UUID),
                templateId: z.string().regex(UUID),
                fields: z.record(z.string().max(64), z.string().max(500)).optional(),
                shared: z.boolean().optional(),
                expiresAt: z.iso.datetime().optional(),
              }),
            ]),
          )
          .min(1)
          .max(20),
        purpose: z.string().min(3).max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const purpose = input.purpose ?? 'making shared documents for a website to find';
        const as = (request: {
          method: string;
          path: string;
          body?: unknown;
          idempotent?: boolean;
        }) =>
          context.connection.as({
            tenantId: chosen.id,
            person: COMPANY,
            purpose,
            ...request,
          });
        const lines: string[] = [];
        let failed = 0;

        for (const [index, wanted] of input.documents.entries()) {
          const label = `#${String(index + 1)}`;
          try {
            let document: DocumentBody;
            if (wanted.kind === 'uploaded') {
              const fields = wanted.fields ?? [];
              const bytes = testPdf(wanted.title, [
                `Reference: ${wanted.reference}`,
                ...fields.map((field) => `${field.label}: ${field.value}`),
              ]);
              const started = await as({
                method: 'POST',
                path: '/v1/media',
                body: { contentType: 'application/pdf', byteSize: bytes.length },
                idempotent: true,
              });
              if (started.status !== 201) {
                throw new Error(`starting the upload: ${describeAnswer(started)}`);
              }
              const { media, upload } = started.body as {
                media: { id: string };
                upload: { url: string; headers: Record<string, string> };
              };
              const sent = await context.connection.upload({
                as: 'upload link',
                url: upload.url,
                headers: upload.headers,
                bytes,
              });
              if (sent.status < 200 || sent.status >= 300) {
                throw new Error(`sending the PDF: the upload link answered ${String(sent.status)}`);
              }
              const completed = await as({
                method: 'POST',
                path: `/v1/media/${media.id}/complete`,
              });
              if (completed.status !== 200) {
                throw new Error(`confirming the upload: ${describeAnswer(completed)}`);
              }
              const made = await as({
                method: 'POST',
                path: '/v1/documents',
                body: {
                  fileId: media.id,
                  title: wanted.title,
                  reference: wanted.reference,
                  fields,
                  shareable: false,
                  ...(wanted.expiresAt === undefined ? {} : { expiresAt: wanted.expiresAt }),
                },
                idempotent: true,
              });
              if (made.status !== 201) {
                throw new Error(`adding it to the register: ${describeAnswer(made)}`);
              }
              document = made.body as DocumentBody;
            } else {
              const made = await context.connection.as({
                tenantId: chosen.id,
                person: COMPANY,
                purpose,
                method: 'POST',
                path: `/v1/submissions/${wanted.submissionId}/documents`,
                body: {
                  templateId: wanted.templateId,
                  fields: wanted.fields ?? {},
                  ...(wanted.expiresAt === undefined ? {} : { expiresAt: wanted.expiresAt }),
                },
                idempotencyKey: randomUUID(),
              });
              if (made.status !== 202) {
                throw new Error(`making it: ${describeAnswer(made)}`);
              }
              document = made.body as DocumentBody;
              const until = Date.now() + PRINT_WAIT_MS;
              while (document.status === 'pending' && Date.now() < until) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const read = await as({ method: 'GET', path: `/v1/documents/${document.id}` });
                if (read.status === 200) {
                  document = read.body as DocumentBody;
                }
              }
              if (document.status !== 'ready') {
                throw new Error(
                  document.status === 'pending'
                    ? `${document.id} is still being printed after 90 s (is the worker running?). Share it later with call_api POST /v1/documents/${document.id}/share.`
                    : `${document.id} could not be printed (${document.failureCode ?? 'no reason given'}).`,
                );
              }
            }
            if (wanted.shared !== false) {
              const shared = await as({
                method: 'POST',
                path: `/v1/documents/${document.id}/share`,
                body: { shareable: true },
              });
              if (shared.status !== 200) {
                throw new Error(`sharing it: ${describeAnswer(shared)}`);
              }
              document = shared.body as DocumentBody;
            }
            const searchable = [
              ...(document.reference === null ? [] : [document.reference]),
              ...document.fields
                .filter((field) => field.lookupRole === 'search' || field.lookupRole === 'key')
                .map((field) => field.value),
            ];
            lines.push(
              `${label} ${document.title}: id ${document.id}, code ${document.publicCode}, ${document.shareable ? 'shared' : 'NOT shared'}${document.linkOpens ? '' : ' (link does not open)'}\n   link ${document.link ?? '(none)'}\n   search values: ${[...new Set(searchable)].join(' | ') || '(none)'}`,
            );
          } catch (error) {
            failed += 1;
            lines.push(`${label} failed ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        const result = [
          `${chosen.name}: ${String(input.documents.length - failed)} of ${String(input.documents.length)} made.`,
          ...lines,
          '',
          'Try them: call_website_api POST /v1/website/documents/lookup with {"q": "<a search value>"}, or GET /v1/website/documents/by-code/<code>.',
        ].join('\n');
        // A made document's answer can carry signed links; none reaches the AI.
        const shown = redact(result) as string;
        return failed === input.documents.length ? failure(shown) : text(shown);
      }),
  );
}
