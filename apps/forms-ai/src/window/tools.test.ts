import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { unpackFormPackage } from '@integr8/form-package';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { createFormsServer } from '../mcp/server.js';
import { tripForm } from './testing/trip-form.js';

/**
 * The preview tools as an AI tool calls them, with a browser that opens
 * nothing: the test plays the person's page over HTTP.
 */

const root = mkdtempSync(join(tmpdir(), 'forms-ai-preview-tools-'));
const output = join(root, 'out');
const host: Host = {
  platform: process.platform,
  arch: process.arch,
  home: join(root, 'home'),
  env: { INTEGR8_FORMS_OUTPUT: output, INTEGR8_FORMS_HOME: join(root, 'install') },
};
const opened: string[] = [];
const client = new Client({ name: 'test', version: '1.0.0' });

beforeAll(async () => {
  const server = createFormsServer({
    host,
    scratch: join(root, 'scratch'),
    browser: () => undefined,
    openUrl: (url) => {
      opened.push(url);
      return Promise.resolve(true);
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

const post = (url: string, path: string, body: unknown) => {
  const address = new URL(url);
  return fetch(`${address.origin}${path}?k=${address.searchParams.get('k') ?? ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

describe('the preview window tools', () => {
  let url = '';

  it('refuses an update before the window is open', async () => {
    const result = await call('update_preview', { definition: tripForm });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/open_preview first/u);
  });

  it('opens the window in the browser and returns the address and the check', async () => {
    const result = await call('open_preview', { definition: tripForm });
    expect(result.error).toBe(false);
    expect(opened).toHaveLength(1);
    url = opened[0] ?? '';
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{48}$/u);
    expect(result.text).toContain(url);
    expect(result.text).toMatch(/OK: the form would publish/u);
  });

  it('keeps what the person typed when the AI changes the form', async () => {
    expect((await post(url, '/answers', { answers: { purpose: 'Audit', km: '40' } })).ok).toBe(
      true,
    );
    expect(
      (await post(url, '/note', { tab: 'form', about: 'km', text: 'Make this required' })).ok,
    ).toBe(true);
    const changed = structuredClone(tripForm);
    changed.title.en = 'Business trip';
    const result = await call('update_preview', { definition: changed });
    expect(result.text).toMatch(/The window refreshed \(version 2\)/u);
    const state = await call('get_preview_state');
    expect(state.text).toMatch(/"purpose": "Audit"/u);
    expect(state.text).toMatch(/\[form tab, about "km", .*\] Make this required/u);
    expect(state.text).toMatch(/Submit: not pressed yet/u);
    // A note is returned once.
    expect((await call('get_preview_state')).text).toMatch(/no new ones/u);
  });

  it('does not open a second browser page while one shows the window', async () => {
    const address = new URL(url);
    const events = await fetch(`${address.origin}/events?k=${address.searchParams.get('k') ?? ''}`);
    const result = await call('open_preview', { definition: tripForm });
    expect(result.text).toMatch(/already open and has refreshed/u);
    expect(opened).toHaveLength(1);
    await events.body?.cancel();
  });

  it('saves from the window the same file save_package writes, asking before replacing', async () => {
    const saved = await post(url, '/save', { fileName: 'Trip' });
    expect(saved.status).toBe(200);
    const { path } = (await saved.json()) as { path: string };
    expect(path).toBe(join(output, 'Trip.integr8form'));
    const unpacked = unpackFormPackage(new Uint8Array(readFileSync(path)));
    expect(unpacked.form).toMatchObject({ title: { en: 'Car trip' } });
    expect((await post(url, '/save', { fileName: 'Trip' })).status).toBe(409);
  });

  it('closes, and the page server stops answering', async () => {
    expect((await call('close_preview')).text).toMatch(/was closed/u);
    await expect(fetch(url)).rejects.toThrow();
    expect((await call('get_preview_state')).text).toMatch(/not open/u);
    expect((await call('close_preview')).text).toMatch(/was not open/u);
  });
});
