import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Host } from './host.js';
import { findExample, type FormExample, type TemplateExample } from './mcp/examples.js';
import { createFormsServer } from './mcp/server.js';
import { EXPECTED_TOOLS } from './setup/self-test.js';

/**
 * Forms for AI makes no network request (decision 15): every tool is called
 * here while `fetch` and every outgoing socket are watched, and none may go
 * anywhere but this computer. The preview window's page server listens on
 * 127.0.0.1, which is allowed; nothing else is. (The installer's update check
 * is the one request the program ever makes, and it is not a tool.)
 */

const root = mkdtempSync(join(tmpdir(), 'forms-ai-offline-'));
const host: Host = {
  platform: process.platform,
  arch: process.arch,
  home: join(root, 'home'),
  env: { INTEGR8_FORMS_OUTPUT: join(root, 'out'), INTEGR8_FORMS_HOME: join(root, 'install') },
};
const client = new Client({ name: 'test', version: '1.0.0' });
const fetchSpy = vi.spyOn(globalThis, 'fetch');
// Called through: the window's page server and the MCP link really run.
const connectSpy = vi.spyOn(Socket.prototype, 'connect');

/** Where a socket was asked to connect: a host name, an address or a local pipe. */
function targetOf(args: readonly unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null) {
    const options = first as { host?: unknown; path?: unknown };
    return typeof options.host === 'string'
      ? options.host
      : typeof options.path === 'string'
        ? 'local pipe'
        : '';
  }
  return typeof second === 'string' ? second : '';
}

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '', 'local pipe']);

beforeAll(async () => {
  fetchSpy.mockImplementation(() => Promise.reject(new Error('No network in this test')));
  const server = createFormsServer({
    host,
    scratch: join(root, 'scratch'),
    browser: () => undefined,
    openUrl: () => Promise.resolve(true),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  fetchSpy.mockRestore();
  connectSpy.mockRestore();
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

describe('no tool leaves this computer', () => {
  it('calls every tool without one outgoing request', async () => {
    const form = (findExample('boiler_service') as FormExample).definition;
    const report = findExample('boiler_service_report') as TemplateExample;
    const template = { name: report.name, design: report.design };
    writeFileSync(join(root, 'page.tsx'), 'export default function Page() { return null; }');

    const calls: [string, Record<string, unknown>][] = [
      ['get_format_guide', {}],
      ['get_interview_guide', {}],
      ['list_examples', {}],
      ['get_example', { key: 'boiler_service' }],
      ['new_picture_ids', {}],
      ['check_form', { definition: form }],
      ['check_package', { definition: form, templates: [template] }],
      ['summarize_form', { definition: form, templates: [template] }],
      ['preview_pdf', { definition: form, template }],
      ['save_package', { definition: form, templates: [template], fileName: 'offline' }],
      ['open_package', { path: join(root, 'out', 'offline.integr8form') }],
      ['open_preview', { definition: form, templates: [template] }],
      ['update_preview', { definition: form }],
      ['get_preview_state', {}],
      [
        'record_change_request',
        {
          title: 'Offline request',
          kind: 'other',
          wanted: 'Nothing',
          why: 'A test',
          blocked: 'Nothing',
          answers: [],
        },
      ],
      ['list_change_requests', {}],
      ['get_change_request', { number: 1 }],
      ['update_change_request', { number: 1, status: 'dropped' }],
      ['close_preview', {}],
      ['get_website_guide', {}],
      ['get_website_api', {}],
      ['get_website_example', {}],
      ['check_website_integration', { paths: [join(root, 'page.tsx')] }],
    ];
    expect(calls.map(([name]) => name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const [name, args] of calls) {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
      expect(result.isError === true, name).toBe(false);
    }
    expect(readdirSync(join(root, 'out', 'change-requests'))).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      connectSpy.mock.calls.map((args) => targetOf(args)).filter((target) => !LOCAL.has(target)),
    ).toEqual([]);
  });
});
