import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { unpackFormPackage } from '@integr8/form-package';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host } from '../host.js';
import { EXPECTED_TOOLS } from '../setup/self-test.js';
import { findExample, type FormExample, type TemplateExample } from './examples.js';
import { createFormsServer } from './server.js';

const root = mkdtempSync(join(tmpdir(), 'forms-ai-server-'));
const output = join(root, 'out');
const host: Host = {
  platform: process.platform,
  arch: process.arch,
  home: join(root, 'home'),
  env: { INTEGR8_FORMS_OUTPUT: output, INTEGR8_FORMS_HOME: join(root, 'install') },
};
const client = new Client({ name: 'test', version: '1.0.0' });

beforeAll(async () => {
  const server = createFormsServer({
    host,
    scratch: join(root, 'scratch'),
    browser: () => undefined,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

interface TextResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
}

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; error: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as TextResult;
  return {
    text: result.content.map((part) => part.text ?? '').join('\n'),
    error: result.isError === true,
  };
}

const boiler = (findExample('boiler_service') as FormExample).definition;
const report = findExample('boiler_service_report') as TemplateExample;
/** A 1 × 1 transparent PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('the MCP tools', () => {
  it('lists every tool with a description', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it('gives the guide, overview with its contents first', async () => {
    const overview = await call('get_format_guide');
    expect(overview.text).toMatch(/# Integr8 forms — overview and workflow/u);
    expect(overview.text).toMatch(/`pdf_templates`/u);
    const pdf = await call('get_format_guide', { section: 'pdf_templates' });
    expect(pdf.text).toMatch(/repeat_table/u);
  });

  it('lists and reads examples', async () => {
    const list = await call('list_examples');
    expect(list.text).toMatch(/boiler_service \(form\)/u);
    const one = JSON.parse((await call('get_example', { key: 'boiler_service_report' })).text) as {
      form: string;
    };
    expect(one.form).toBe('boiler_service');
    expect((await call('get_example', { key: 'nope' })).error).toBe(true);
  });

  it('makes picture ids', async () => {
    const ids = (await call('new_picture_ids', { count: 3 })).text.split('\n');
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    }
  });

  it('checks a form: OK, then every problem with its path and code', async () => {
    expect((await call('check_form', { definition: boiler })).text).toMatch(
      /^OK: the form would publish\. 0 warnings/u,
    );
    const broken = structuredClone(boiler) as {
      pages: { sections: { fields: Record<string, unknown>[] }[] }[];
    };
    const fields = broken.pages[0]?.sections[1]?.fields ?? [];
    fields.push({ ...fields[0], label: { en: 'Again' } });
    const result = await call('check_form', { definition: broken });
    expect(result.text).toMatch(/^NOT OK/u);
    expect(result.text).toMatch(/\[duplicate_id\]/u);
    expect(result.text).toMatch(/As JSON:/u);
  });

  it('warns about a missing translation without blocking', async () => {
    const english = structuredClone(boiler) as { title: Record<string, string> };
    english.title = { en: 'Boiler service' };
    const result = await call('check_form', { definition: english });
    expect(result.text).toMatch(/^OK/u);
    expect(result.text).toMatch(/\[translation_missing\] This text has no Arabic/u);
  });

  it('checks templates against the form and pictures against the templates', async () => {
    const ok = await call('check_package', {
      definition: boiler,
      templates: [{ name: report.name, design: report.design }],
    });
    expect(ok.text).toMatch(/^OK/u);
    const wrong = structuredClone(report.design) as { blocks: Record<string, unknown>[] };
    wrong.blocks.push({ type: 'field', id: 'ghost', fieldId: 'no_such_question' });
    const bad = await call('check_package', {
      definition: boiler,
      templates: [{ name: report.name, design: wrong }],
      pictures: [{ id: '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d', base64: PNG }],
    });
    expect(bad.text).toMatch(/templates\/1\.json › design\.blocks/u);
    expect(bad.text).toMatch(/\[unknown_field\]/u);
    expect(bad.text).toMatch(/\[file_unused\]/u);
  });

  it('previews without a browser by saying so', async () => {
    const result = await call('preview_pdf', {
      definition: boiler,
      template: { name: report.name, design: report.design },
    });
    expect(result.error).toBe(false);
    expect(result.text).toMatch(/No preview: No Chrome, Edge or Chromium was found/u);
  });

  it('saves, refuses to overwrite, overwrites when asked, and opens the file again', async () => {
    const id = '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d';
    const design = structuredClone(report.design) as { blocks: Record<string, unknown>[] };
    design.blocks.unshift({
      type: 'image',
      id: 'banner',
      source: { kind: 'file', fileId: id },
      width: 60,
    });
    const input = {
      definition: boiler,
      settings: { signatureRequired: true },
      templates: [{ name: report.name, design }],
      pictures: [{ id, base64: PNG }],
    };
    const saved = await call('save_package', input);
    expect(saved.error).toBe(false);
    const path = join(output, 'Boiler service.integr8form');
    expect(saved.text).toContain(path);
    expect(existsSync(path)).toBe(true);

    const unpacked = unpackFormPackage(new Uint8Array(readFileSync(path)));
    expect(unpacked.manifest.createdBy.app).toBe('integr8-forms-ai');
    expect(unpacked.manifest.form.source).toBe('draft');
    expect(unpacked.settings.signatureRequired).toBe(true);
    expect(unpacked.files.map((file) => file.id)).toEqual([id]);

    const again = await call('save_package', input);
    expect(again.error).toBe(true);
    expect(again.text).toMatch(/already exists/u);
    expect(again.text).toMatch(/"overwrite": true/u);

    const replaced = await call('save_package', { ...input, overwrite: true });
    expect(replaced.text).toMatch(/^Replaced/u);

    const opened = await call('open_package', { path });
    expect(opened.error).toBe(false);
    const contents = JSON.parse(
      opened.text.slice(opened.text.indexOf('Contents:\n') + 'Contents:\n'.length),
    ) as {
      definition: unknown;
      settings: unknown;
      templates: { name: string; design: unknown }[];
      pictures: { id: string; path: string }[];
    };
    expect(contents.definition).toEqual(boiler);
    expect(contents.templates[0]?.name).toBe(report.name);

    // Round trip: what open_package gives back saves into the same package.
    const resaved = await call('save_package', {
      definition: contents.definition,
      settings: contents.settings,
      templates: contents.templates,
      pictures: contents.pictures.map((picture) => ({ id: picture.id, path: picture.path })),
      fileName: 'Round trip',
    });
    expect(resaved.error).toBe(false);
    const back = unpackFormPackage(
      new Uint8Array(readFileSync(join(output, 'Round trip.integr8form'))),
    );
    expect(back.form).toEqual(unpacked.form);
    expect(back.templates).toEqual(unpacked.templates);
    expect(back.settings).toEqual(unpacked.settings);
    expect(back.files.map((file) => Buffer.from(file.bytes).toString('base64'))).toEqual([PNG]);
  });

  it('refuses a picture that is not an image', async () => {
    const result = await call('save_package', {
      definition: boiler,
      pictures: [
        {
          id: '0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d',
          base64: Buffer.from('<svg/>').toString('base64'),
        },
      ],
      fileName: 'svg',
    });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/not a readable PNG, JPEG or WebP/u);
  });

  it('reports a file that is not a package', async () => {
    const result = await call('open_package', { path: join(root, 'missing.integr8form') });
    expect(result.error).toBe(true);
    expect(result.text).toMatch(/No file at/u);
  });
});
