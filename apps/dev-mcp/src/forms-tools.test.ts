import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FORMS_TOOLS, type Host } from '@integr8/forms-ai/tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotSignedInError } from './connection.js';
import { RouteIndex } from './openapi.js';
import { createDevServer, DRAFT_REQUEST_TOOLS } from './server.js';
import { Trace } from './trace.js';

/**
 * The developer server carries every Integr8 Forms for AI tool, so a developer
 * needs one MCP server. What is proved: all of them are listed beside the
 * developer tools (two renamed, none clashing), the instructions explain both
 * sets, and the Forms tools work with nobody signed in, while the developer
 * tools still say how to sign in.
 */

const root = mkdtempSync(join(tmpdir(), 'dev-mcp-forms-'));
const output = join(root, 'out');
const host: Host = {
  platform: process.platform,
  arch: process.arch,
  home: join(root, 'home'),
  env: { INTEGR8_FORMS_OUTPUT: output, INTEGR8_FORMS_HOME: join(root, 'install') },
};
const client = new Client({ name: 'test', version: '1.0.0' });

const DEV_TOOLS = [
  'status',
  'list_test_companies',
  'create_test_company',
  'use_company',
  'find_route',
  'get_route',
  'call_api',
  'get_trace',
  'get_audit',
  'read_outbox',
  'import_form_package',
  'submit_form',
  'list_change_requests',
  'get_change_request',
];

beforeAll(async () => {
  const server = createDevServer({
    routes: RouteIndex.load(),
    trace: new Trace({ folder: join(root, 'trace') }),
    // Nobody is signed in.
    context: () =>
      Promise.reject(
        new NotSignedInError('Not signed in. Run pnpm dev-mcp login --api <address>.'),
      ),
    requestsFolder: join(root, 'no-requests'),
    forms: {
      host,
      scratch: join(root, 'scratch'),
      browser: () => undefined,
      openUrl: () => Promise.resolve(false),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  return {
    text: result.content.map((part) => part.text ?? '').join('\n'),
    error: result.isError === true,
  };
}

describe('the Forms for AI tools in the developer server', () => {
  it('lists every Forms tool beside the developer tools, renaming the two that clash', async () => {
    const renamed: Record<string, string> = {
      list_change_requests: DRAFT_REQUEST_TOOLS.list,
      get_change_request: DRAFT_REQUEST_TOOLS.get,
    };
    const expected = [...DEV_TOOLS, ...FORMS_TOOLS.map((name) => renamed[name] ?? name)];
    expect(new Set(expected).size).toBe(expected.length);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(expected.sort());
  });

  it('explains both sets of tools in its instructions', () => {
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toMatch(/^Integr8 developer tools:/u);
    expect(instructions).toContain('Integr8 Forms builds .integr8form files');
    expect(instructions).toContain(DRAFT_REQUEST_TOOLS.list);
    expect(instructions).toContain('import_form_package');
  });

  it('builds, checks and saves a form with nobody signed in', async () => {
    const overview = await call('get_format_guide', { section: 'overview' });
    expect(overview.error).toBe(false);
    const example = JSON.parse((await call('get_example', { key: 'boiler_service' })).text) as {
      definition: Record<string, unknown>;
    };
    const checked = await call('check_form', { definition: example.definition });
    expect(checked.text).toMatch(/^OK: the form would publish/u);
    const saved = await call('save_package', { definition: example.definition });
    expect(saved.error).toBe(false);
    const path = join(output, 'Boiler service.integr8form');
    expect(saved.text).toContain(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('keeps change requests on this computer and in the repository apart', async () => {
    const drafts = await call(DRAFT_REQUEST_TOOLS.list);
    expect(drafts.error).toBe(false);
    expect(drafts.text).toContain(join(output, 'change-requests'));
    const repository = await call('list_change_requests');
    expect(repository.text).toBe('No change requests in plan/requests/.');
  });

  it('still asks for a sign-in on the developer tools', async () => {
    const status = await call('status');
    expect(status.error).toBe(true);
    expect(status.text).toMatch(/pnpm dev-mcp login/u);
  });
});
