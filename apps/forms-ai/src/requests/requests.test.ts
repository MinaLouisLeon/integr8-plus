import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { unpackFormPackage } from '@integr8/form-package';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { createFormsServer } from '../mcp/server.js';
import { tripForm } from '../window/testing/trip-form.js';
import {
  parseRequest,
  RequestFormatError,
  renderRequest,
  requestFolderName,
  type ChangeRequest,
} from './format.js';
import { findRequest, listRequests, recordRequest, updateRequest } from './store.js';

const root = mkdtempSync(join(tmpdir(), 'forms-ai-requests-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const sample: ChangeRequest = {
  header: {
    number: 7,
    title: 'Mileage claims from a form',
    date: '2026-11-10',
    kind: 'form_action',
    status: 'open',
    mergedInto: null,
    form: 'Car trip',
    madeWith: 'Integr8 Forms for AI 1.3.6',
  },
  wanted: 'After the trip form is submitted, a mileage claim is made for the engineer.',
  why: 'Accounting types every claim again from the forms.',
  blocked: 'check_form: Unrecognized key "actions".',
  answers: [
    { question: 'For whom?', answer: 'Engineers, and the accountant who approves.' },
    { question: 'Which apps?', answer: 'The phone, and the web for approval.\nDesktop too.' },
  ],
};

describe('the request format', () => {
  it('reads back what it writes', () => {
    const text = renderRequest(sample);
    expect(text).toMatch(/^# CR-0007 — Mileage claims from a form$/mu);
    expect(text).toMatch(/\| Kind \| `form_action` \|/u);
    expect(parseRequest(text)).toEqual(sample);
  });

  it('refuses a header that does not check', () => {
    const broken = renderRequest(sample).replace('`form_action`', '`magic`');
    expect(() => parseRequest(broken)).toThrow(RequestFormatError);
  });

  it('names a folder from the number and title', () => {
    expect(requestFolderName(7, 'Mileage claims from a form!')).toBe(
      'CR-0007-mileage-claims-from-a-form',
    );
    expect(requestFolderName(8, 'مطالبات')).toBe('CR-0008-request');
  });
});

describe('the requests on this computer', () => {
  const folder = join(root, 'store');
  const body = {
    wanted: sample.wanted,
    why: sample.why,
    blocked: sample.blocked,
    answers: sample.answers,
    madeWith: 'Integr8 Forms for AI test',
  };

  it('records numbered folders, with the example packed when it can be', () => {
    const first = recordRequest(folder, {
      ...body,
      title: 'Mileage claims',
      kind: 'form_action',
      example: { definition: tripForm, settings: undefined, templates: [], pictures: [] },
      pictures: [{ name: 'preview-form.png', png: new Uint8Array([1, 2, 3]) }],
    });
    expect(first.header).toMatchObject({ number: 1, status: 'open', form: 'Car trip' });
    expect(first.files).toEqual(['example.integr8form', 'preview-form.png', 'request.md']);
    const unpacked = unpackFormPackage(
      new Uint8Array(readFileSync(join(first.folder, 'example.integr8form'))),
    );
    expect(unpacked.form).toMatchObject({ title: { en: 'Car trip' } });

    const second = recordRequest(folder, {
      ...body,
      title: 'Expense actions',
      kind: 'form_format',
      example: {
        definition: { ...tripForm, actions: [{ kind: 'expense' }] },
        settings: undefined,
        templates: [],
        pictures: [],
      },
    });
    expect(second.header.number).toBe(2);
    expect(second.files).toContain('request.md');
    expect(listRequests(folder).requests.map((entry) => entry.header.number)).toEqual([1, 2]);
  });

  it('merges, drops, renames and refuses a merge into nothing', () => {
    expect(updateRequest(folder, 2, { mergeInto: 1 }).header).toMatchObject({
      status: 'merged',
      mergedInto: 1,
    });
    expect(() => updateRequest(folder, 1, { mergeInto: 9 })).toThrow(/no CR-0009/u);
    expect(() => updateRequest(folder, 1, { mergeInto: 1 })).toThrow(/itself/u);
    const renamed = updateRequest(folder, 1, { title: 'Mileage claims made by a form' });
    expect(renamed.folder).toMatch(/CR-0001-mileage-claims-made-by-a-form$/u);
    expect(updateRequest(folder, 1, { status: 'handed_over' }).header.status).toBe('handed_over');
    expect(findRequest(folder, 1).request.answers).toEqual(sample.answers);
  });
});

describe('the change-request tools', () => {
  const output = join(root, 'out');
  const host: Host = {
    platform: process.platform,
    arch: process.arch,
    home: join(root, 'home'),
    env: { INTEGR8_FORMS_OUTPUT: output, INTEGR8_FORMS_HOME: join(root, 'install') },
  };
  const client = new Client({ name: 'test', version: '1.0.0' });
  let windowUrl = '';

  beforeAll(async () => {
    const server = createFormsServer({
      host,
      scratch: join(root, 'scratch'),
      browser: () => undefined,
      openUrl: (url) => {
        windowUrl = url;
        return Promise.resolve(true);
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  });

  afterAll(async () => {
    await client.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    return {
      text: result.content.map((part) => part.text ?? '').join('\n'),
      error: result.isError === true,
    };
  };

  it('offers a change request when the check refuses something the format lacks', async () => {
    const refused = await call('check_form', {
      definition: { ...tripForm, actions: [{ kind: 'expense' }] },
    });
    expect(refused.text).toMatch(/The platform cannot do this yet\. Shall I record it/u);
    const fine = await call('check_form', { definition: tripForm });
    expect(fine.text).not.toMatch(/record it as a change request/u);
  });

  it('passes a platform suggestion from the window to the AI', async () => {
    await call('open_preview', { definition: tripForm });
    const address = new URL(windowUrl);
    await fetch(`${address.origin}/note?k=${address.searchParams.get('k') ?? ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: 'form', text: 'Claims from this form', platform: true }),
    });
    const state = await call('get_preview_state');
    expect(state.text).toMatch(/PLATFORM SUGGESTION, form tab/u);
    expect(state.text).toMatch(/record_change_request/u);
  });

  it('records a request from the window, and the window lists it', async () => {
    const recorded = await call('record_change_request', {
      title: 'Mileage claims from a form',
      kind: 'form_action',
      wanted: sample.wanted,
      why: sample.why,
      blocked: sample.blocked,
      answers: sample.answers,
    });
    expect(recorded.error).toBe(false);
    expect(recorded.text).toMatch(/Recorded CR-0001 "Mileage claims from a form"/u);
    expect(recorded.text).toMatch(/no pictures/u);
    expect(recorded.text).toMatch(/plan\/requests\//u);
    const folder = join(output, 'change-requests', 'CR-0001-mileage-claims-from-a-form');
    expect(readdirSync(folder).sort()).toEqual(['example.integr8form', 'request.md']);

    const address = new URL(windowUrl);
    const listed = (await (
      await fetch(`${address.origin}/requests?k=${address.searchParams.get('k') ?? ''}`)
    ).json()) as { items: { number: number; status: string }[] };
    expect(listed.items).toEqual([expect.objectContaining({ number: 1, status: 'open' })]);
  });

  it('lists, reads and updates requests', async () => {
    expect((await call('list_change_requests')).text).toMatch(
      /CR-0001 Mileage claims from a form \[form_action, open/u,
    );
    expect((await call('get_change_request', { number: 1 })).text).toMatch(
      /## What was wanted\n\nAfter the trip form/u,
    );
    expect((await call('update_change_request', { number: 1, status: 'dropped' })).text).toMatch(
      /CR-0001 is now dropped/u,
    );
    expect((await call('get_change_request', { number: 4 })).error).toBe(true);
    await call('close_preview');
  });

  it('keeps an example without a window when given one, and none when asked', async () => {
    const none = await call('record_change_request', {
      title: 'A new question type',
      kind: 'form_format',
      wanted: 'A barcode question.',
      why: 'Parts carry barcodes.',
      blocked: 'No such type.',
      answers: [],
      example: 'none',
    });
    expect(none.text).toMatch(/Recorded CR-0002/u);
    expect(
      existsSync(join(output, 'change-requests', 'CR-0002-a-new-question-type', 'request.md')),
    ).toBe(true);
  });
});
