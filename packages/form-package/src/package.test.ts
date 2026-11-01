import { DESIGN_SCHEMA_VERSION } from '@integr8/document-render';
import { describe, expect, it } from 'vitest';
import {
  checkFormPackage,
  FORM_PACKAGE_FORMAT_VERSION,
  FormPackageError,
  type FormPackageErrorCode,
  packFormPackage,
  unpackFormPackage,
  type UnpackOptions,
} from './index.js';
import {
  BACKGROUND_ID,
  boilerDefinition,
  boilerDesign,
  boilerInput,
  JPEG,
  jsonBytes,
  LOGO_ID,
  PNG,
  type RawPackage,
  rawBoiler,
  sha256,
  WEBP_EXTENDED,
  WEBP_LOSSLESS,
  WEBP_LOSSY,
  zipRaw,
} from './test-support/fixtures.js';
import { writeZip } from './zip.js';

function refusal(run: () => unknown): FormPackageError {
  try {
    run();
  } catch (error) {
    if (error instanceof FormPackageError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a FormPackageError');
}

function refusedWith(code: FormPackageErrorCode, bytes: Uint8Array, options?: UnpackOptions) {
  const error = refusal(() => unpackFormPackage(bytes, options));
  expect(error.code, error.message).toBe(code);
  expect(error.problems.length).toBeGreaterThan(0);
  return error;
}

const tampered = (change: (raw: RawPackage) => void) => {
  const raw = rawBoiler();
  change(raw);
  return zipRaw(raw);
};

/** Sets an entry's declared size in both its local header and the ZIP directory. */
function declareSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = Buffer.from(zip);
  const end = out.length - 22;
  let at = out.readUInt32LE(end + 16);
  const count = out.readUInt16LE(end + 10);
  for (let index = 0; index < count; index += 1) {
    const nameLength = out.readUInt16LE(at + 28);
    const entryName = out.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (entryName === name) {
      out.writeUInt32LE(size, at + 24);
      out.writeUInt32LE(size, out.readUInt32LE(at + 42) + 22);
    }
    at += 46 + nameLength + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

describe('a round trip', () => {
  it('reads back exactly what it packed, Arabic included', () => {
    const input = boilerInput();
    const bytes = packFormPackage(input);
    const unpacked = unpackFormPackage(bytes);

    expect(unpacked.manifest).toMatchObject({
      format: 'integr8form',
      formatVersion: FORM_PACKAGE_FORMAT_VERSION,
      createdBy: { app: 'integr8-plus', version: '1.3.0' },
      createdAt: '2026-11-01T09:30:00.000Z',
      form: {
        title: { en: 'Boiler service', ar: 'صيانة الغلاية' },
        schemaVersion: 1,
        source: 'published',
        versionNumber: 3,
      },
      templates: [{ path: 'templates/1.json', name: 'Service report' }],
    });
    expect(unpacked.manifest.files.map((file) => file.path)).toEqual([
      `files/${BACKGROUND_ID}.png`,
      `files/${LOGO_ID}.jpg`,
    ]);
    expect(unpacked.form).toEqual(boilerDefinition());
    expect(unpacked.settings).toEqual({
      fillRoles: ['owner', 'engineer'],
      signatureRequired: true,
    });
    expect(unpacked.templates).toHaveLength(1);
    expect(unpacked.templates[0]?.name).toBe('Service report');
    expect(unpacked.templates[0]?.design).toEqual(boilerDesign());
    expect(JSON.stringify(unpacked.templates[0]?.design)).toContain('تقرير الصيانة');
    expect(unpacked.files.map((file) => [file.id, file.contentType])).toEqual([
      [BACKGROUND_ID, 'image/png'],
      [LOGO_ID, 'image/jpeg'],
    ]);
    expect(Buffer.from(unpacked.files[0]?.bytes ?? []).equals(PNG)).toBe(true);
    expect(Buffer.from(unpacked.files[1]?.bytes ?? []).equals(JPEG)).toBe(true);

    expect(checkFormPackage(unpacked)).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('packs the same content to the same bytes', () => {
    expect(Buffer.from(packFormPackage(boilerInput())).equals(packFormPackage(boilerInput()))).toBe(
      true,
    );
  });

  it('packs a form with no templates, with default settings', () => {
    const unpacked = unpackFormPackage(
      packFormPackage({
        createdBy: { app: 'integr8-forms-ai', version: '1.3.0' },
        definition: boilerDefinition(),
        source: 'draft',
      }),
    );
    expect(unpacked.templates).toEqual([]);
    expect(unpacked.files).toEqual([]);
    expect(unpacked.manifest.form).not.toHaveProperty('versionNumber');
    expect(unpacked.settings).toEqual({
      fillRoles: ['owner', 'admin', 'dispatcher', 'engineer', 'viewer'],
      signatureRequired: false,
    });
  });

  it('carries every kind of WebP', () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];
    const design = boilerDesign();
    design.page.background = null;
    design.blocks = design.blocks.filter((block) => block.type !== 'image');
    ids.forEach((fileId, index) => {
      design.blocks.push({
        type: 'image',
        id: `picture_${String(index)}`,
        source: { kind: 'file', fileId },
        width: 20,
        align: 'start',
      });
    });
    const unpacked = unpackFormPackage(
      packFormPackage(
        boilerInput({
          templates: [{ name: 'Pictures', design }],
          files: [WEBP_LOSSY, WEBP_LOSSLESS, WEBP_EXTENDED].map((bytes, index) => ({
            id: ids[index] ?? '',
            contentType: 'image/webp' as const,
            bytes,
          })),
        }),
      ),
    );
    expect(unpacked.manifest.files.map((file) => file.path)).toEqual(
      ids.map((id) => `files/${id}.webp`),
    );
  });

  it('upgrades a version 1 design', () => {
    const v1 = {
      schemaVersion: 1,
      page: {
        margins: { top: 20, end: 15, bottom: 20, start: 15 },
        footer: { pageNumbers: true, text: { en: 'Thank you', ar: 'شكرا' } },
      },
      blocks: [{ type: 'field', id: 'serial', fieldId: 'serial_number' }],
    };
    const fromPack = unpackFormPackage(
      packFormPackage(boilerInput({ templates: [{ name: 'Old', design: v1 }], files: [] })),
    );
    expect(fromPack.templates[0]?.design.schemaVersion).toBe(DESIGN_SCHEMA_VERSION);

    const fromFile = unpackFormPackage(
      tampered((raw) => {
        raw.templates = [{ name: 'Service report', design: v1 }];
        raw.manifest.files = [];
        raw.files = [];
      }),
    );
    expect(fromFile.templates[0]?.design.schemaVersion).toBe(DESIGN_SCHEMA_VERSION);
    expect(fromFile.templates[0]?.design.page.footer.start).toMatchObject({
      kind: 'text',
      text: { ar: 'شكرا' },
    });
  });

  it('works out the form format the definition needs', () => {
    const definition = boilerDefinition();
    definition.pages[0]?.sections[0]?.fields.unshift({
      type: 'information',
      id: 'safety_note',
      style: 'warning',
      body: { en: 'Isolate the gas first.', ar: 'اعزل الغاز أولا.' },
    });
    const unpacked = unpackFormPackage(packFormPackage(boilerInput({ definition })));
    expect(unpacked.manifest.form.schemaVersion).toBe(2);
    expect(unpacked.form.schemaVersion).toBe(2);
    expect(checkFormPackage(unpacked).ok).toBe(true);
  });

  it('reads a package with folder entries and a byte order mark', () => {
    const raw = rawBoiler();
    const bytes = zipRaw({
      ...raw,
      extra: [
        { name: 'templates/', data: new Uint8Array(), compress: false },
        { name: 'files/', data: new Uint8Array(), compress: false },
      ],
    });
    expect(unpackFormPackage(bytes).templates).toHaveLength(1);

    const withBom = writeZip(
      [
        {
          name: 'manifest.json',
          data: Buffer.concat([Buffer.from('\uFEFF'), jsonBytes({ ...raw.manifest, files: [] })]),
          compress: false,
        },
        { name: 'form.json', data: jsonBytes(raw.form), compress: true },
        {
          name: 'templates/1.json',
          data: jsonBytes({ name: 'Service report', design: { ...boilerDesign(), blocks: [] } }),
          compress: true,
        },
      ],
      new Date(),
    );
    const design = boilerDesign();
    expect(design.page.background).not.toBeNull();
    // The design above still has its background; strip it so no picture is needed.
    const noPictures = writeZip(
      [
        {
          name: 'manifest.json',
          data: Buffer.concat([Buffer.from('\uFEFF'), jsonBytes({ ...raw.manifest, files: [] })]),
          compress: false,
        },
        { name: 'form.json', data: jsonBytes(raw.form), compress: true },
        {
          name: 'templates/1.json',
          data: jsonBytes({
            name: 'Service report',
            design: { ...design, page: { ...design.page, background: null }, blocks: [] },
          }),
          compress: true,
        },
      ],
      new Date(),
    );
    refusedWith('package_file_mismatch', withBom);
    expect(unpackFormPackage(noPictures).templates[0]?.design.blocks).toEqual([]);
  });
});

describe('the ZIP itself', () => {
  it('refuses what is not a ZIP', () => {
    refusedWith('package_invalid', new Uint8Array());
    refusedWith('package_invalid', new TextEncoder().encode('{"format":"integr8form"}'.repeat(4)));
  });

  it('refuses a file past the size limit before reading it', () => {
    const bytes = packFormPackage(boilerInput());
    refusedWith('package_too_large', bytes, { limits: { fileBytes: bytes.length - 1 } });
  });

  it('refuses too many entries', () => {
    refusedWith('package_too_large', packFormPackage(boilerInput()), { limits: { entries: 3 } });
  });

  it('refuses an entry declared bigger than its limit, without inflating it', () => {
    const bytes = declareSize(packFormPackage(boilerInput()), 'form.json', 400 * 1024 * 1024);
    const error = refusedWith('package_too_large', bytes);
    expect(error.problems[0]?.entry).toBe('form.json');
  });

  it('refuses entries that together inflate past the total', () => {
    refusedWith('package_too_large', packFormPackage(boilerInput()), {
      limits: { totalBytes: 1000 },
    });
  });

  it('stops inflating a ZIP bomb at the size it declared', () => {
    const raw = rawBoiler();
    // 64 MB of spaces deflate to about 64 KB; the entry claims 2 KB.
    const bomb = Buffer.alloc(64 * 1024 * 1024, 0x20);
    const zip = writeZip(
      [
        { name: 'manifest.json', data: jsonBytes(raw.manifest), compress: true },
        { name: 'form.json', data: bomb, compress: true },
        ...raw.files.map((file) => ({ name: file.path, data: file.bytes, compress: false })),
      ],
      new Date(),
    );
    expect(zip.length).toBeLessThan(200 * 1024);
    const started = Date.now();
    const error = refusedWith('package_too_large', declareSize(zip, 'form.json', 2048));
    expect(error.message).toContain('inflates to more than');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses a damaged entry', () => {
    const bytes = Buffer.from(packFormPackage(boilerInput()));
    // The PNG is stored as it is; change one of its bytes.
    const at = bytes.indexOf(PNG.subarray(0, 16)) + 40;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    refusedWith('package_invalid', bytes);
  });

  it('refuses an encrypted entry', () => {
    const bytes = Buffer.from(packFormPackage(boilerInput()));
    const directory = bytes.readUInt32LE(bytes.length - 22 + 16);
    bytes.writeUInt16LE(0x0801, directory + 8);
    refusedWith('package_invalid', bytes);
  });

  it('refuses entries that overlap', () => {
    const bytes = Buffer.from(packFormPackage(boilerInput({ templates: [], files: [] })));
    const directory = bytes.readUInt32LE(bytes.length - 22 + 16);
    // Point the second directory entry at the first entry's local header.
    const second = directory + 46 + bytes.readUInt16LE(directory + 28);
    const copy = Buffer.from(bytes);
    copy.writeUInt32LE(0, second + 42);
    refusedWith('package_invalid', copy);
  });

  it('refuses ZIP64 markers', () => {
    const bytes = Buffer.from(packFormPackage(boilerInput()));
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 10);
    bytes.writeUInt16LE(0xffff, bytes.length - 22 + 8);
    refusedWith('package_invalid', bytes);
  });
});

describe('entries', () => {
  it.each([
    '../escape.json',
    '/etc/passwd',
    'files\\..\\evil.png',
    'C:/Windows/evil.png',
    'templates/../../evil.json',
    'templates//1.json',
    'nul\u0000.json',
  ])('refuses the path %j', (name) => {
    const error = refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        raw.extra = [{ name, data: jsonBytes({}), compress: true }];
      }),
    );
    expect(error.problems[0]?.code).toBe('unsafe_path');
  });

  it('refuses an entry the format has no place for', () => {
    const error = refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        raw.extra = [{ name: 'notes.txt', data: jsonBytes('hello'), compress: true }];
      }),
    );
    expect(error.problems[0]).toMatchObject({ entry: 'notes.txt', code: 'unknown_entry' });
  });

  it('refuses a template the manifest does not list', () => {
    const error = refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        raw.templates.push({ name: 'Second', design: boilerDesign() });
      }),
    );
    expect(error.problems[0]).toMatchObject({ entry: 'templates/2.json', code: 'unlisted_entry' });
  });

  it('refuses an entry twice, in any case', () => {
    refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        raw.extra = [{ name: 'form.json', data: jsonBytes(raw.form), compress: true }];
      }),
    );
    refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        raw.extra = [{ name: 'FORM.json', data: jsonBytes(raw.form), compress: true }];
      }),
    );
  });

  it('refuses a package without a manifest or a form', () => {
    const raw = rawBoiler();
    refusedWith(
      'package_invalid',
      writeZip([{ name: 'form.json', data: jsonBytes(raw.form), compress: true }], new Date()),
    );
    refusedWith(
      'package_invalid',
      writeZip(
        [{ name: 'manifest.json', data: jsonBytes(raw.manifest), compress: true }],
        new Date(),
      ),
    );
  });

  it('refuses a template the manifest lists but the package lacks', () => {
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        raw.templates = [];
      }),
    );
  });
});

describe('the manifest', () => {
  it('refuses a key it does not know, at any level', () => {
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        raw.manifest.signedBy = 'someone';
      }),
    );
    const error = refusedWith(
      'package_invalid',
      tampered((raw) => {
        (raw.manifest.form as Record<string, unknown>).jobTypes = ['x'];
      }),
    );
    expect(error.problems[0]).toMatchObject({ entry: 'manifest.json', path: 'form' });
  });

  it('refuses a manifest that is not JSON, or not this format', () => {
    refusedWith(
      'package_invalid',
      writeZip(
        [{ name: 'manifest.json', data: new TextEncoder().encode('{ nope'), compress: true }],
        new Date(),
      ),
    );
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        raw.manifest.format = 'something-else';
      }),
    );
  });

  it('refuses JSON nested past the limit', () => {
    let deep: unknown = 1;
    for (let level = 0; level < 300; level += 1) {
      deep = [deep];
    }
    refusedWith(
      'package_form_invalid',
      tampered((raw) => {
        raw.form = { ...(raw.form as object), deep };
      }),
    );
  });

  it('refuses a newer package format as too new', () => {
    const error = refusedWith(
      'package_too_new',
      tampered((raw) => {
        raw.manifest.formatVersion = FORM_PACKAGE_FORMAT_VERSION + 1;
        // A newer format may have entries and keys this one has never heard of.
        raw.manifest.signatures = [];
        raw.extra = [{ name: 'signatures/1.json', data: jsonBytes({}), compress: true }];
      }),
    );
    expect(error.message).toContain('newer Integr8 Plus');
  });

  it('refuses a template path out of order', () => {
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        raw.manifest.templates = [{ path: 'templates/2.json', name: 'Service report' }];
      }),
    );
  });

  it('refuses a form format the manifest and the form disagree on', () => {
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        (raw.manifest.form as Record<string, unknown>).schemaVersion = 2;
      }),
    );
  });

  it('refuses a template whose name differs from the manifest', () => {
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        raw.templates = [{ name: 'Another name', design: boilerDesign() }];
      }),
    );
  });
});

describe('the form', () => {
  it('refuses a form format newer than this engine', () => {
    const error = refusedWith(
      'package_too_new',
      tampered((raw) => {
        const form = raw.form as { definition: Record<string, unknown> };
        form.definition.schemaVersion = 99;
        form.definition.somethingNew = true;
        (raw.manifest.form as Record<string, unknown>).schemaVersion = 99;
      }),
    );
    expect(error.problems[0]).toMatchObject({
      entry: 'form.json',
      path: 'definition.schemaVersion',
    });
    expect(
      refusal(() => packFormPackage(boilerInput({ definition: { schemaVersion: 3 } }))).code,
    ).toBe('package_too_new');
  });

  it('refuses what is not a draft definition with its settings', () => {
    refusedWith(
      'package_form_invalid',
      tampered((raw) => {
        raw.form = {
          definition: { pages: [] },
          settings: { fillRoles: ['owner'], signatureRequired: false },
        };
      }),
    );
    refusedWith(
      'package_form_invalid',
      tampered((raw) => {
        raw.form = {
          definition: { schemaVersion: 0 },
          settings: { fillRoles: ['owner'], signatureRequired: false },
        };
      }),
    );
    const error = refusedWith(
      'package_form_invalid',
      tampered((raw) => {
        raw.form = {
          definition: boilerDefinition(),
          settings: { fillRoles: ['owner', 'captain'], signatureRequired: false },
        };
      }),
    );
    expect(error.problems[0]?.path).toBe('settings.fillRoles[1]');
    refusedWith(
      'package_form_invalid',
      tampered((raw) => {
        raw.form = {
          definition: boilerDefinition(),
          settings: { fillRoles: [], signatureRequired: false },
          jobTypeIds: [],
        };
      }),
    );
  });

  it('keeps a half-built draft: only publishing needs a whole form', () => {
    const draft = { schemaVersion: 1, title: { en: 'Half built' }, pages: [] };
    const unpacked = unpackFormPackage(
      packFormPackage({
        createdBy: { app: 'integr8-forms-ai', version: '1.3.0' },
        definition: draft,
        source: 'draft',
      }),
    );
    expect(unpacked.form).toEqual(draft);
    const check = checkFormPackage(unpacked);
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toMatchObject({ entry: 'form.json', code: 'invalid_structure' });
  });

  it('refuses to pack a form with no title', () => {
    expect(
      refusal(() => packFormPackage(boilerInput({ definition: { schemaVersion: 1, pages: [] } })))
        .code,
    ).toBe('package_form_invalid');
  });
});

describe('templates', () => {
  it('refuses a design newer than this designer', () => {
    refusedWith(
      'package_too_new',
      tampered((raw) => {
        raw.templates = [
          { name: 'Service report', design: { schemaVersion: 3, wholeNewThing: {} } },
        ];
      }),
    );
  });

  it('refuses a design the designer cannot read, saying where', () => {
    const design = boilerDesign() as unknown as { blocks: Record<string, unknown>[] };
    design.blocks.push({ type: 'hologram', id: 'h' });
    const error = refusedWith(
      'package_template_invalid',
      tampered((raw) => {
        raw.templates = [{ name: 'Service report', design }];
      }),
    );
    expect(error.problems[0]?.entry).toBe('templates/1.json');
    expect(error.problems[0]?.path).toMatch(/^design\.blocks/u);
  });

  it('refuses a template without a name, or with keys it does not know', () => {
    refusedWith(
      'package_template_invalid',
      tampered((raw) => {
        raw.templates = [{ name: '', design: boilerDesign() }];
      }),
    );
    refusedWith(
      'package_template_invalid',
      tampered((raw) => {
        raw.templates = [{ name: 'Service report', design: boilerDesign(), formId: 'x' }];
      }),
    );
  });
});

describe('pictures', () => {
  it('refuses a picture whose hash differs from the manifest', () => {
    const error = refusedWith(
      'package_file_mismatch',
      tampered((raw) => {
        const files = raw.manifest.files as { sha256: string }[];
        files[0]!.sha256 = sha256(JPEG);
      }),
    );
    expect(error.problems[0]?.code).toBe('file_hash');
  });

  it('refuses a picture whose length differs from the manifest', () => {
    refusedWith(
      'package_file_mismatch',
      tampered((raw) => {
        const files = raw.manifest.files as { bytes: number }[];
        files[0]!.bytes += 1;
      }),
    );
  });

  it('refuses a PNG named .jpg', () => {
    const error = refusedWith(
      'package_image_invalid',
      tampered((raw) => {
        const files = raw.manifest.files as { bytes: number; sha256: string }[];
        files[1]!.bytes = PNG.length;
        files[1]!.sha256 = sha256(PNG);
        raw.files[1]!.bytes = PNG;
      }),
    );
    expect(error.message).toContain('image/png');
    expect(
      refusal(() =>
        packFormPackage(
          boilerInput({
            files: [
              { id: BACKGROUND_ID, contentType: 'image/png', bytes: PNG },
              { id: LOGO_ID, contentType: 'image/jpeg', bytes: PNG },
            ],
          }),
        ),
      ).code,
    ).toBe('package_image_invalid');
  });

  it('refuses a name and a content type that disagree', () => {
    refusedWith(
      'package_image_invalid',
      tampered((raw) => {
        const files = raw.manifest.files as { contentType: string }[];
        files[1]!.contentType = 'image/png';
      }),
    );
  });

  it('refuses a text file posing as a picture', () => {
    const text = new TextEncoder().encode('<svg onload="alert(1)"></svg> not really a png');
    refusedWith(
      'package_image_invalid',
      tampered((raw) => {
        const files = raw.manifest.files as { bytes: number; sha256: string }[];
        files[0]!.bytes = text.length;
        files[0]!.sha256 = sha256(text);
        raw.files[0]!.bytes = text;
      }),
    );
  });

  it('refuses a picture a template uses that the package lacks', () => {
    const error = refusedWith(
      'package_file_mismatch',
      tampered((raw) => {
        raw.manifest.files = (raw.manifest.files as unknown[]).slice(0, 1);
        raw.files = raw.files.slice(0, 1);
      }),
    );
    expect(error.problems[0]).toMatchObject({ entry: 'templates/1.json', code: 'file_missing' });
  });

  it('refuses a picture the manifest lists but the package lacks', () => {
    refusedWith(
      'package_file_mismatch',
      tampered((raw) => {
        raw.files = raw.files.slice(0, 1);
      }),
    );
  });

  it('refuses a picture no template uses', () => {
    const stray = '44444444-4444-4444-8444-444444444444';
    const error = refusedWith(
      'package_entry_unexpected',
      tampered((raw) => {
        (raw.manifest.files as unknown[]).push({
          id: stray,
          path: `files/${stray}.png`,
          contentType: 'image/png',
          bytes: PNG.length,
          sha256: sha256(PNG),
        });
        raw.files.push({ path: `files/${stray}.png`, bytes: PNG });
      }),
    );
    expect(error.problems[0]).toMatchObject({ code: 'file_unused' });
    expect(
      refusal(() =>
        packFormPackage(
          boilerInput({
            files: [
              ...(boilerInput().files ?? []),
              { id: stray, contentType: 'image/png', bytes: PNG },
            ],
          }),
        ),
      ).code,
    ).toBe('package_entry_unexpected');
  });

  it('refuses a picture past its size limit', () => {
    refusedWith('package_too_large', packFormPackage(boilerInput()), {
      limits: { imageBytes: 100 },
    });
  });

  it('refuses a picture too large in pixels', () => {
    const huge = Buffer.from(PNG);
    huge.writeUInt32BE(20_000, 16);
    expect(
      refusal(() =>
        packFormPackage(
          boilerInput({
            files: [
              { id: BACKGROUND_ID, contentType: 'image/png', bytes: huge },
              { id: LOGO_ID, contentType: 'image/jpeg', bytes: JPEG },
            ],
          }),
        ),
      ).code,
    ).toBe('package_image_invalid');
  });

  it('refuses a picture id in capitals', () => {
    const upper = BACKGROUND_ID.toUpperCase();
    const design = boilerDesign();
    design.page.background = { fileId: upper };
    const error = refusal(() =>
      packFormPackage(
        boilerInput({
          templates: [{ name: 'Service report', design }],
          files: [
            { id: upper, contentType: 'image/png', bytes: PNG },
            { id: LOGO_ID, contentType: 'image/jpeg', bytes: JPEG },
          ],
        }),
      ),
    );
    expect(error.code).toBe('package_invalid');
    expect(error.problems[0]).toMatchObject({ entry: 'manifest.json', path: 'files[0].id' });
  });

  it('refuses the same picture twice', () => {
    expect(
      refusal(() =>
        packFormPackage(
          boilerInput({
            files: [
              { id: BACKGROUND_ID, contentType: 'image/png', bytes: PNG },
              { id: BACKGROUND_ID, contentType: 'image/png', bytes: PNG },
            ],
          }),
        ),
      ).code,
    ).toBe('package_invalid');
    refusedWith(
      'package_invalid',
      tampered((raw) => {
        const files = raw.manifest.files as unknown[];
        files.push(files[0]);
      }),
    );
  });
});

describe('deflated entries are inflated, stored ones are not', () => {
  it('reads a stored JSON entry and a deflated picture', () => {
    const raw = rawBoiler();
    const zip = writeZip(
      [
        { name: 'manifest.json', data: jsonBytes(raw.manifest), compress: false },
        { name: 'form.json', data: jsonBytes(raw.form), compress: false },
        { name: 'templates/1.json', data: jsonBytes(raw.templates[0]), compress: false },
        ...raw.files.map((file) => ({ name: file.path, data: file.bytes, compress: true })),
      ],
      new Date(),
    );
    expect(unpackFormPackage(zip).files).toHaveLength(2);
  });
});
