import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type ApiAnswer, type Connection, NotSignedInError, type Person } from './connection.js';
import type { SeededCompany } from './local.js';
import { checkRequest, type RouteIndex, routeLine } from './openapi.js';
import { redact } from './redact.js';
import { getRepoRequest, listRepoRequests } from './requests.js';
import type { Trace } from './trace.js';

/**
 * The developer MCP server's tools (P38): find a route, call it as one of a
 * test company's people, and read back what happened (the trace, the audit
 * lines, the outbox). It has no tool that signs in and none that returns a
 * token: the person signs in in a terminal, and every answer passes through
 * `redact` before the AI sees it.
 */

export interface DevContext {
  mode: 'remote' | 'local';
  connection: Connection;
  /** Only in local mode: runs the seeder. */
  createCompany?: (input: {
    ownerEmail: string;
    name?: string;
    only?: string[];
  }) => Promise<SeededCompany>;
}

export interface DevServerOptions {
  /** The connection, or a NotSignedInError saying how to sign in. */
  context: () => Promise<DevContext>;
  routes: RouteIndex;
  trace: Trace;
  /** Where handed-over change requests are (P39); the repository's plan/requests/ by default. */
  requestsFolder?: string;
}

const INSTRUCTIONS = `Integr8 developer tools: try features of this repository on a running Integr8 Plus API, as the people of a TEST company. You never sign in and never see a password, an authenticator code or a token: the person signs in in a terminal (pnpm dev-mcp login --api <address>); if a tool says the session is missing or over, ask them to do that, and never ask them for a password or code.
Rules: test companies only (the API refuses anything else). On production (status says the environment), say what you are about to do before any write, and start with read-only calls. Everything you do is audited under the person's staff account and appears in the company's audit log with your stated purpose.
Workflow: status → list_test_companies (create_test_company in local mode) → use_company → find_route / get_route → call_api as a role, a person or "company" → get_trace, get_audit, read_outbox to see what it did. import_form_package and submit_form cover the form flow in one call each.`;

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });
const failure = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  isError: true,
});
const show = (value: unknown) => JSON.stringify(redact(value), null, 2);

interface Company {
  id: string;
  name: string;
  slug: string;
}

interface Member {
  userId: string;
  email: string;
  displayName: string;
  role: string;
  status?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function describeAnswer(answer: ApiAnswer, extra: string[] = []): string {
  return [
    `${String(answer.status)} in ${String(answer.trace.durationMs)} ms (trace #${String(answer.trace.id)}${answer.trace.requestId === null ? '' : `, request ${answer.trace.requestId}`}, as ${answer.trace.as})`,
    ...extra,
    '',
    show(answer.body),
  ].join('\n');
}

export function createDevServer(options: DevServerOptions): McpServer {
  const { routes, trace } = options;
  let company: Company | undefined;
  let people: Member[] = [];

  const server = new McpServer(
    { name: 'integr8-dev', title: 'Integr8 developer tools', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  const guarded = async (work: (context: DevContext) => Promise<CallToolResult>) => {
    try {
      return await work(await options.context());
    } catch (error) {
      if (error instanceof NotSignedInError) {
        return failure(error.message);
      }
      return failure(error instanceof Error ? error.message : String(error));
    }
  };

  const needCompany = (): Company => {
    if (company === undefined) {
      throw new Error('Choose a test company first: list_test_companies, then use_company.');
    }
    return company;
  };

  const personFor = (as: string): Person => {
    if (as === 'company') {
      return { key: 'company', label: 'company' };
    }
    const wanted = as.trim().toLowerCase();
    const member =
      people.find((candidate) => candidate.userId.toLowerCase() === wanted) ??
      people.find((candidate) => candidate.email.toLowerCase() === wanted) ??
      people.find((candidate) => candidate.role === wanted && candidate.status !== 'suspended');
    if (member === undefined) {
      throw new Error(
        `Nobody in ${needCompany().name} matches "${as}". Use "company", a role (${[...new Set(people.map((p) => p.role))].join(', ')}), an email or a user id from use_company.`,
      );
    }
    return { key: member.userId, label: `${member.role} ${member.email}` };
  };

  const companies = async (context: DevContext): Promise<(Company & Record<string, unknown>)[]> => {
    const answer = await context.connection.staff({
      method: 'GET',
      path: '/v1/platform/companies',
    });
    if (answer.status !== 200) {
      throw new Error(`Listing companies failed: ${describeAnswer(answer)}`);
    }
    return (answer.body as { items: (Company & Record<string, unknown>)[] }).items;
  };

  server.registerTool(
    'status',
    {
      title: 'Where the developer tools are pointed',
      description:
        'The mode (remote or local), the API address, its environment (production needs care), the signed-in staff account, how long the session has left (it ends 8 hours after sign-in), the chosen test company, open impersonation grants and the trace file.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guarded(async (context) => {
        const me = await context.connection.staff({ method: 'GET', path: '/v1/platform/me' });
        if (me.status !== 200) {
          throw new NotSignedInError(
            'The staff session is not accepted. Ask the person to sign in again in a terminal: pnpm dev-mcp login',
          );
        }
        const account = me.body as {
          email: string;
          scope: string;
          sessionExpiresAt: string;
          environment: string;
        };
        const minutes = Math.max(
          0,
          Math.round((new Date(account.sessionExpiresAt).getTime() - Date.now()) / 60_000),
        );
        return text(
          [
            `Mode: ${context.mode}`,
            `API: ${context.connection.api}`,
            `Environment: ${account.environment}${account.environment === 'production' ? ' (real customers live here: say what you will do before any write)' : ''}`,
            `Signed in as: ${account.email} (session limited to ${account.scope === 'test_companies' ? 'test companies' : account.scope})`,
            `Session ends in: ${String(Math.floor(minutes / 60))} h ${String(minutes % 60)} min`,
            `Company: ${company === undefined ? 'none chosen (use_company)' : `${company.name} (${company.slug}, ${company.id})`}`,
            `Open impersonation grants: ${String(context.connection.openGrants)}`,
            `Trace file: ${trace.file ?? '(not written)'}`,
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    'list_test_companies',
    {
      title: 'List the test companies',
      description:
        'The test companies this session can use: name, slug, id, status, people and when they were created. Real companies are never listed (the API leaves them out for this session).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      guarded(async (context) => {
        const items = await companies(context);
        if (items.length === 0) {
          return text(
            context.mode === 'local'
              ? 'No test company yet. Make one with create_test_company.'
              : 'No test company on this API yet. One is made on the machine with the seeder (see create_test_company).',
          );
        }
        return text(
          items
            .map(
              (item) =>
                `- ${item.name} (slug ${item.slug}, id ${item.id}, ${String(item.status)}, ${String(item.activeMembers)} people, created ${String(item.createdAt)})`,
            )
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'create_test_company',
    {
      title: 'Create a seeded test company (local mode)',
      description:
        'Local mode only: runs the demo seeder, which makes a new test company with every module on and realistic data in every section (or only the sections named), its people without sign-in accounts. Takes a few minutes. In remote mode it explains the command to run on the machine instead.',
      inputSchema: {
        ownerEmail: z
          .string()
          .max(254)
          .optional()
          .describe(
            'The owner the seeder records (default dev-mcp@example.com); nobody is emailed.',
          ),
        name: z
          .string()
          .max(120)
          .optional()
          .describe('The company name (default chosen by the seeder).'),
        only: z
          .array(z.string().max(40))
          .max(20)
          .optional()
          .describe(
            'Seeder section keys, e.g. ["forms", "field-service"]; setup, customers and stock always run.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        if (context.createCompany === undefined) {
          return text(
            [
              'Remote mode cannot create a company. On production and the test box a test company is made on the machine by the person, with the seeder:',
              '',
              '  docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/demo/cli.js --owner-email <their address> --confirm-production',
              '',
              'Every company the seeder makes is a test company. Then call list_test_companies.',
            ].join('\n'),
          );
        }
        const made = await context.createCompany({
          ownerEmail: input.ownerEmail ?? 'dev-mcp@example.com',
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.only === undefined ? {} : { only: input.only }),
        });
        return text(
          `Created ${made.name} (slug ${made.slug}, id ${made.tenantId}). Call use_company with its slug.\n\n${made.output.trim().split('\n').slice(-25).join('\n')}`,
        );
      }),
  );

  server.registerTool(
    'use_company',
    {
      title: 'Choose the test company to work in',
      description:
        'Chooses a test company (by slug or id) for the calls that follow, and lists its people with their roles, emails and user ids: what call_api and submit_form accept as "as".',
      inputSchema: {
        company: z.string().min(1).max(200).describe('A slug or id from list_test_companies.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ company: wanted }) =>
      guarded(async (context) => {
        const found = (await companies(context)).find(
          (item) => item.id === wanted || item.slug === wanted.toLowerCase(),
        );
        if (found === undefined) {
          return failure(`No test company "${wanted}". See list_test_companies.`);
        }
        company = { id: found.id, name: found.name, slug: found.slug };
        people = [];
        const answer = await context.connection.as({
          tenantId: found.id,
          person: { key: 'company', label: 'company' },
          purpose: 'listing the company’s people',
          method: 'GET',
          path: '/v1/members',
          query: { limit: '200' },
        });
        if (answer.status === 200) {
          people = (answer.body as { items: Member[] }).items;
        }
        return text(
          [
            `Working in ${found.name} (${found.slug}, ${found.id}).`,
            '',
            people.length === 0
              ? `Its people could not be listed (${String(answer.status)}).`
              : 'People ("as" accepts "company", a role, an email or a user id):',
            ...people.map(
              (person) =>
                `- ${person.role.padEnd(18)} ${person.displayName} <${person.email}> ${person.userId}${person.status === undefined || person.status === 'active' ? '' : ` (${person.status})`}`,
            ),
          ].join('\n'),
        );
      }),
  );

  server.registerTool(
    'find_route',
    {
      title: 'Find API routes',
      description:
        'Searches the API’s routes (apps/api/openapi.json, generated from the route registry) by words, a path or a tag; every word must match. One line each: method, path, summary, operation id and permission.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('Words, e.g. "submit submission" or "/v1/work-orders".'),
        tag: z.string().max(60).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query, tag, limit }) => {
      const found = routes.search(query, {
        ...(tag === undefined ? {} : { tag }),
        limit: limit ?? 20,
      });
      return Promise.resolve(
        text(found.length === 0 ? 'No route matches.' : found.map(routeLine).join('\n')),
      );
    },
  );

  server.registerTool(
    'get_route',
    {
      title: 'Read one API route in full',
      description:
        'One route: parameters, body schema, response schemas, the permission it needs, its module, and whether it needs an Idempotency-Key (call_api adds one).',
      inputSchema: {
        operationId: z.string().max(120).optional(),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        path: z.string().max(300).optional().describe('With {param} or a concrete path.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => {
      const route = routes.find({
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        ...(input.method === undefined ? {} : { method: input.method }),
        ...(input.path === undefined ? {} : { path: input.path }),
      });
      return Promise.resolve(
        route === undefined
          ? failure('No such route. Give operationId, or method and path; see find_route.')
          : text(JSON.stringify(route, null, 2)),
      );
    },
  );

  server.registerTool(
    'call_api',
    {
      title: 'Call the API as one of the company’s people',
      description:
        'Sends one request to the chosen test company as "company", a role (the first active member with it), an email or a user id. Checks the request against the route’s schema first, adds the client headers and an Idempotency-Key where the route takes one, and starts an audited impersonation grant (reason "Developer MCP: <purpose>") when that person has none. Returns the status, body, timing, request id and the audit lines the call wrote. Platform (staff) routes are not called this way.',
      inputSchema: {
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        path: z.string().min(1).max(500).describe('A concrete path, e.g. /v1/work-orders/<id>.'),
        as: z.string().min(1).max(320).describe('"company", a role, an email or a user id.'),
        purpose: z
          .string()
          .min(3)
          .max(300)
          .describe('What you are testing, in a few words: written to the company’s audit log.'),
        query: z.record(z.string(), z.unknown()).optional(),
        body: z.unknown().optional(),
        idempotencyKey: z.string().max(200).optional().describe('To repeat a call deliberately.'),
        skipCheck: z
          .boolean()
          .optional()
          .describe('Send even if the schema check fails (to test the API’s own refusal).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const path = input.path.split('?')[0] ?? '';
        if (path.startsWith('/v1/platform/')) {
          return failure(
            'Staff routes are not called as a person. Use status, list_test_companies, get_audit or read_outbox.',
          );
        }
        const route = routes.find({ method: input.method, path });
        if (route === undefined) {
          return failure(`No route ${input.method} ${path}. See find_route.`);
        }
        const query = input.query ?? {};
        if (input.skipCheck !== true) {
          const problems = checkRequest(route, { path, query, body: input.body });
          if (problems.length > 0) {
            return failure(
              `Not sent: the request does not fit ${route.operationId}.\n${problems.map((problem) => `- ${problem.where}: ${problem.message}`).join('\n')}\nFix it, or pass skipCheck to test the API's own refusal.`,
            );
          }
        }
        const person = personFor(input.as);
        const since = new Date(Date.now() - 2000).toISOString();
        const answer = await context.connection.as({
          tenantId: chosen.id,
          person,
          purpose: input.purpose,
          method: input.method,
          path,
          query,
          ...(input.body === undefined ? {} : { body: input.body }),
          idempotent: route.idempotency !== null && input.method !== 'GET',
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        });
        const audit = await auditLines(context, chosen.id, since, answer.trace.requestId);
        return text(
          describeAnswer(answer, [
            audit.length === 0
              ? 'Audit lines from this call: none.'
              : `Audit lines from this call:\n${audit.map((line) => `- ${line}`).join('\n')}`,
          ]),
        );
      }),
  );

  const auditLines = async (
    context: DevContext,
    tenantId: string,
    since: string,
    requestId: string | null,
  ): Promise<string[]> => {
    if (requestId === null) {
      return [];
    }
    const answer = await context.connection.staff({
      method: 'GET',
      path: `/v1/platform/companies/${tenantId}/test-audit`,
      query: { since, limit: '100' },
    });
    if (answer.status !== 200) {
      return [];
    }
    return (
      answer.body as {
        items: {
          id: string;
          action: string;
          resourceType: string;
          resourceId: string | null;
          requestId: string | null;
        }[];
      }
    ).items
      .filter((entry) => entry.requestId === requestId)
      .map(
        (entry) =>
          `${entry.id} ${entry.action} ${entry.resourceType}${entry.resourceId === null ? '' : ` ${entry.resourceId}`}`,
      );
  };

  server.registerTool(
    'get_trace',
    {
      title: 'Read the requests and answers of this session',
      description:
        'The recent requests this server sent and the answers, newest first (one line each), or one in full by its trace number. Tokens, passwords, codes and signed links are hidden. The same is written to the trace file (status).',
      inputSchema: {
        id: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id, limit }) => {
      if (id !== undefined) {
        const entry = trace.find(id);
        return Promise.resolve(
          entry === undefined
            ? failure(`No trace #${String(id)} in memory.`)
            : text(JSON.stringify(entry, null, 2)),
        );
      }
      const recent = trace.recent(limit ?? 20);
      return Promise.resolve(
        text(
          recent.length === 0
            ? 'Nothing sent yet.'
            : recent
                .map(
                  (entry) =>
                    `#${String(entry.id)} ${entry.at} ${entry.method} ${entry.path} → ${String(entry.status)} (${String(entry.durationMs)} ms, as ${entry.as})`,
                )
                .join('\n'),
        ),
      );
    },
  );

  server.registerTool(
    'get_audit',
    {
      title: 'Read the company’s audit lines',
      description:
        'The chosen test company’s audit log since a moment (default: the last hour), newest first: who did what to which record. Every action this server takes appears here under the signed-in staff account.',
      inputSchema: {
        since: z.iso.datetime().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ since, limit }) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const answer = await context.connection.staff({
          method: 'GET',
          path: `/v1/platform/companies/${chosen.id}/test-audit`,
          query: {
            since: since ?? new Date(Date.now() - 3_600_000).toISOString(),
            limit: String(limit ?? 50),
          },
        });
        return answer.status === 200 ? text(show(answer.body)) : failure(describeAnswer(answer));
      }),
  );

  server.registerTool(
    'read_outbox',
    {
      title: 'Read what the company would have emailed or pushed',
      description:
        'A test company sends no email or push notification; each is kept for 7 days instead. Newest first, with recipient, subject, words and attachments by name.',
      inputSchema: {
        since: z.iso.datetime().optional(),
        channel: z.enum(['email', 'push']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ since, channel, limit }) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const answer = await context.connection.staff({
          method: 'GET',
          path: `/v1/platform/companies/${chosen.id}/test-outbox`,
          query: {
            ...(since === undefined ? {} : { since }),
            ...(channel === undefined ? {} : { channel }),
            limit: String(limit ?? 20),
          },
        });
        return answer.status === 200 ? text(show(answer.body)) : failure(describeAnswer(answer));
      }),
  );

  server.registerTool(
    'import_form_package',
    {
      title: 'Import a .integr8form file into the company',
      description:
        'Imports a .integr8form file (from Forms for AI or its preview window) into the chosen test company as a new draft form, acting as the company (forms are staff-only), and publishes it if asked: the step between building a form and testing it.',
      inputSchema: {
        path: z.string().min(1).max(1000).describe('Absolute path of the .integr8form file.'),
        publish: z.boolean().optional(),
        purpose: z.string().min(3).max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        if (!isAbsolute(input.path)) {
          return failure('Give the absolute path of the .integr8form file.');
        }
        if (statSync(input.path).size > 50 * 1024 * 1024) {
          return failure('That file is larger than a form file can be.');
        }
        const purpose = input.purpose ?? 'importing a form file to test it';
        const company: Person = { key: 'company', label: 'company' };
        const imported = await context.connection.as({
          tenantId: chosen.id,
          person: company,
          purpose,
          method: 'POST',
          path: '/v1/forms/import',
          rawBody: {
            bytes: new Uint8Array(readFileSync(input.path)),
            contentType: 'application/vnd.integr8.form+zip',
          },
          idempotent: true,
        });
        if (imported.status !== 201 || input.publish !== true) {
          return text(describeAnswer(imported));
        }
        const formId = (imported.body as { formId: string }).formId;
        const published = await context.connection.as({
          tenantId: chosen.id,
          person: company,
          purpose,
          method: 'POST',
          path: `/v1/forms/${formId}/draft/publish`,
          body: {},
        });
        return text(`${describeAnswer(imported)}\n\nPublish:\n${describeAnswer(published)}`);
      }),
  );

  server.registerTool(
    'submit_form',
    {
      title: 'Start and submit a form as a person',
      description:
        'The common flow in one call: starts a submission of a published form (optionally on a job or an asset) as the given person and submits it with the given answers. Returns both answers, including the API’s refusal and its reasons when the answers do not pass.',
      inputSchema: {
        formId: z.string().regex(UUID),
        as: z.string().min(1).max(320),
        answers: z.record(z.string(), z.unknown()),
        workOrderId: z.string().regex(UUID).optional(),
        assetId: z.string().regex(UUID).optional(),
        title: z.string().min(1).max(200).optional(),
        purpose: z.string().min(3).max(300).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    (input) =>
      guarded(async (context) => {
        const chosen = needCompany();
        const person = personFor(input.as);
        const purpose = input.purpose ?? 'filling and submitting a form';
        const started = await context.connection.as({
          tenantId: chosen.id,
          person,
          purpose,
          method: 'POST',
          path: '/v1/submissions',
          body: {
            formId: input.formId,
            ...(input.workOrderId === undefined ? {} : { workOrderId: input.workOrderId }),
            ...(input.assetId === undefined ? {} : { assetId: input.assetId }),
          },
          idempotent: true,
        });
        if (started.status !== 201) {
          return failure(`Starting failed:\n${describeAnswer(started)}`);
        }
        const submission = (started.body as { submission: { id: string; revision?: number } })
          .submission;
        const submitted = await context.connection.as({
          tenantId: chosen.id,
          person,
          purpose,
          method: 'POST',
          path: `/v1/submissions/${submission.id}/submit`,
          body: {
            answers: input.answers,
            expectedRevision: submission.revision ?? 1,
            ...(input.title === undefined ? {} : { title: input.title }),
          },
        });
        return text(
          `Started:\n${describeAnswer(started)}\n\nSubmitted:\n${describeAnswer(submitted)}`,
        );
      }),
  );

  server.registerTool(
    'list_change_requests',
    {
      title: 'List the change requests handed to the repository',
      description:
        'The change requests in plan/requests/ (copied there from Integr8 Forms for AI, or written by hand): code, title, kind and status. Start planning one with docs/contributing/planning-a-change-request.md.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => {
      const found = listRepoRequests(options.requestsFolder);
      return Promise.resolve(
        text(
          found.length === 0
            ? 'No change requests in plan/requests/.'
            : found
                .map(
                  (request) =>
                    `- ${request.code} ${request.title} [${request.kind ?? 'kind?'}, ${request.status ?? 'status?'}]${request.files.length === 0 ? '' : ` (${request.files.join(', ')})`}`,
                )
                .join('\n'),
        ),
      );
    },
  );

  server.registerTool(
    'get_change_request',
    {
      title: 'Read one change request from the repository',
      description:
        'One change request from plan/requests/ in full, by its code (CR-0001) or number, with the files beside it (its example .integr8form opens with Forms for AI’s open_package; import it with import_form_package).',
      inputSchema: {
        request: z.union([z.string().regex(/^CR-\d{4}$/iu), z.number().int().min(1).max(9999)]),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ request }) => {
      const found = getRepoRequest(request, options.requestsFolder);
      return Promise.resolve(
        found === undefined
          ? failure(`No ${String(request)} in plan/requests/. See list_change_requests.`)
          : text(
              [
                found.file,
                ...(found.files.length === 0 ? [] : [`Files beside it: ${found.files.join(', ')}`]),
                '',
                found.text,
              ].join('\n'),
            ),
      );
    },
  );

  return server;
}
