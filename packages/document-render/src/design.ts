import {
  type CompiledForm,
  type Field,
  type LocalizedText,
  localizedTextSchema,
} from '@integr8/form-engine';
import { z } from 'zod';
import { DOCUMENT_FONT_KEYS } from './fonts.js';
import {
  bandIsEmpty,
  headerFooterSchema,
  type HeaderFooterSpec,
  hexColourSchema,
  type Margins,
  marginsSchema,
} from './look.js';

/**
 * A PDF template's design (docs/documents/ADR-0001 D1-D3, D6).
 *
 * A template is a column of blocks on A4 pages, portrait or landscape, one
 * under another, with a row block for two or three side by side, a header
 * and a footer with three places each, and a style: brand colour, font,
 * table lines. It names the form's fields
 * by id, never by label, so a label changed in the form changes the document
 * with it. The design is data: the designer edits it, the API validates it
 * with {@link parseDesign} and {@link checkDesignAgainstForm} before storing
 * it, and the renderer reads it.
 */

/**
 * 2 (1.3.0) added the header, the three-place footer, landscape pages, the
 * template's style and each block's colour. A version 1 design is upgraded on
 * reading ({@link upgradeDesign}) into one that prints exactly as it did.
 */
export const DESIGN_SCHEMA_VERSION = 2;

/** Limits that keep a template a document rather than a program. */
export const DESIGN_LIMITS = {
  blocks: 300,
  fields: 20,
  rowColumns: 3,
  tableRows: 100,
  tableColumns: 8,
  textLength: 4000,
} as const;

/** A header or footer place holds a line or two, not a paragraph. */
const BAND_TEXT_LENGTH = 500;

const ID = /^[a-z][a-z0-9_]{0,63}$/u;
const elementId = z.string().regex(ID);
const blockId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const fileId = z.uuid();
const text = localizedTextSchema;
const optionalText = localizedTextSchema.optional();
const align = z.enum(['start', 'center', 'end']).default('start');
const millimetres = (min: number, max: number) => z.number().min(min).max(max);

export { marginsSchema };
export type { Margins };

/** A footer as every template had before headers: page numbers at the end. */
export const DEFAULT_FOOTER: HeaderFooterSpec = {
  start: null,
  center: null,
  end: { kind: 'page' },
  notOnFirstPage: false,
};

/**
 * The template's look (D9 of the 1.3.0 decisions). `brandColour`: `company`
 * for the company's accent colour at the moment of printing, a `#rrggbb` of
 * its own, or null for black (every template made before 1.3.0).
 */
export const styleSchema = z.object({
  brandColour: z
    .union([z.literal('company'), hexColourSchema])
    .nullable()
    .default('company'),
  font: z.enum(DOCUMENT_FONT_KEYS).default('noto-sans'),
  /** The lines of every table: none, light grey (before 1.3.0), or strong. */
  tableLines: z.enum(['none', 'light', 'strong']).default('light'),
  /** Every other row of a table lightly shaded. */
  stripedRows: z.boolean().default(false),
  /** Table header rows lightly shaded. */
  headerShading: z.boolean().default(true),
});
export type TemplateStyle = z.infer<typeof styleSchema>;

/** How every template made before 1.3.0 looks. */
export const CLASSIC_STYLE: TemplateStyle = {
  brandColour: null,
  font: 'noto-sans',
  tableLines: 'light',
  stripedRows: false,
  headerShading: true,
};

/** A block's text colour, from the palette (D9). */
export const BLOCK_COLOURS = ['black', 'grey', 'brand', 'red'] as const;
export type BlockColour = (typeof BLOCK_COLOURS)[number];
/** What any block that shows text may set besides its own settings. */
const appearance = {
  colour: z.enum(BLOCK_COLOURS).optional(),
  /** A light background behind the whole block. */
  shaded: z.boolean().optional(),
};

export const pageSchema = z.object({
  /** Always A4 (D3). Named so a reader of the JSON knows. */
  size: z.literal('A4').default('A4'),
  /** Portrait (210 x 297 mm) or landscape (297 x 210 mm); backgrounds are drawn to match. */
  orientation: z.enum(['portrait', 'landscape']).default('portrait'),
  margins: marginsSchema,
  /** An image drawn behind every page, or behind every page but the first when that differs. */
  background: z.object({ fileId }).nullable().default(null),
  /**
   * Set when the first page differs (D3): its own image, or `null` for a
   * plain first page. Absent when the first page is like the others.
   */
  firstPage: z
    .object({
      background: z.object({ fileId }).nullable(),
      /**
       * The first page's own top margin, for a letterhead taller than the
       * band on the other pages. `null` keeps the template's.
       */
      topMargin: millimetres(0, 120).nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * The language the document is printed in: its labels, yes and no, dates,
   * the page direction. `null` follows the company's own language.
   */
  language: z.enum(['en', 'ar']).nullable().default(null),
  /** Base text size in points. */
  fontSize: z.number().min(7).max(16).default(10),
  /** Printed in the top margin of every page, or every page but the first. */
  header: headerFooterSchema.nullable().default(null),
  /** Printed in the bottom margin; before 1.3.0 page numbers and a line of text. */
  footer: headerFooterSchema.default(DEFAULT_FOOTER),
});
export type PageSettings = z.infer<typeof pageSchema>;

/** Where a document field's value comes from (D6). */
export const fieldSourceSchema = z.discriminatedUnion('kind', [
  /** Typed by the person making the PDF. */
  z.object({
    kind: z.literal('typed'),
    required: z.boolean().default(false),
    maxLength: z.number().int().min(1).max(500).default(120),
  }),
  /** One of the form's answers, as the document shows it. */
  z.object({ kind: z.literal('answer'), fieldId: elementId }),
  /** A fact about the submission. */
  z.object({
    kind: z.literal('submission'),
    value: z.enum([
      'form_title',
      'submitted_date',
      'submitted_by',
      'work_order_reference',
      'asset_reference',
      'document_date',
    ]),
  }),
]);
export type FieldSource = z.infer<typeof fieldSourceSchema>;

export const documentFieldSchema = z.object({
  key: elementId,
  label: text,
  source: fieldSourceSchema,
  /**
   * Whether a company's website may find the document by this field (D10):
   * `key` is what the visitor types; `confirm` is a second field that must
   * match too. At most one of each per template.
   */
  lookup: z.enum(['none', 'key', 'confirm']).default('none'),
});
export type DocumentField = z.infer<typeof documentFieldSchema>;

const headingBlock = z.object({
  type: z.literal('heading'),
  id: blockId,
  ...appearance,
  text,
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  align,
});

const textBlock = z.object({
  type: z.literal('text'),
  id: blockId,
  ...appearance,
  /** May hold placeholders: `{{answer.<field>}}`, `{{field.<key>}}`, `{{company.name}}`, … */
  text,
  align,
  size: z.enum(['small', 'normal', 'large']).default('normal'),
  bold: z.boolean().default(false),
});

const fieldBlock = z.object({
  type: z.literal('field'),
  id: blockId,
  ...appearance,
  fieldId: elementId,
  /** The form's own label when absent. */
  label: optionalText,
  layout: z.enum(['inline', 'stacked', 'value_only']).default('inline'),
});

const checkboxBlock = z.object({
  type: z.literal('checkbox'),
  id: blockId,
  ...appearance,
  fieldId: elementId,
  /**
   * For a choice field, the option that ticks the box; for yes/no, `yes`,
   * `no` or `not_applicable` (default `yes`). Unused for a checkbox field.
   */
  option: z.string().min(1).max(64).optional(),
  label: optionalText,
});

const optionsBlock = z.object({
  type: z.literal('options'),
  id: blockId,
  ...appearance,
  /** A choice, yes/no or checkbox field: every option, each with its box. */
  fieldId: elementId,
  label: optionalText,
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(1),
});

const fieldsTableBlock = z.object({
  type: z.literal('fields_table'),
  id: blockId,
  ...appearance,
  title: optionalText,
  rows: z
    .array(z.object({ fieldId: elementId, label: optionalText }))
    .min(1)
    .max(DESIGN_LIMITS.tableRows),
});

const repeatTableBlock = z.object({
  type: z.literal('repeat_table'),
  id: blockId,
  ...appearance,
  /** A repeating section: one row per entry. */
  sectionId: elementId,
  title: optionalText,
  columns: z
    .array(
      z.object({
        fieldId: elementId,
        header: optionalText,
        /** Share of the table's width, in percent; the rest is shared equally. */
        width: z.number().min(5).max(100).optional(),
      }),
    )
    .min(1)
    .max(DESIGN_LIMITS.tableColumns),
  /** Numbers each row, 1, 2, 3. */
  numbered: z.boolean().default(false),
});

const staticTableBlock = z.object({
  type: z.literal('static_table'),
  id: blockId,
  ...appearance,
  title: optionalText,
  header: z.array(text).max(DESIGN_LIMITS.tableColumns).default([]),
  rows: z
    .array(z.array(text).min(1).max(DESIGN_LIMITS.tableColumns))
    .min(1)
    .max(DESIGN_LIMITS.tableRows),
});

const imageBlock = z.object({
  type: z.literal('image'),
  id: blockId,
  ...appearance,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('logo') }),
    z.object({ kind: z.literal('file'), fileId }),
    /** A photo or signature answer: every image it holds. */
    z.object({ kind: z.literal('answer'), fieldId: elementId }),
  ]),
  /** Width in millimetres; a photo answer's images are each this wide. */
  width: millimetres(5, 190).default(40),
  align,
  caption: optionalText,
});

const qrBlock = z.object({
  type: z.literal('qr'),
  id: blockId,
  ...appearance,
  size: millimetres(15, 80).default(30),
  align,
  caption: optionalText,
});

/**
 * One of the form's Information blocks (form schema version 2), printed as the
 * form shows it — heading, paragraph, style — when it is shown for these
 * answers. A block prints only where a template puts it, never by itself.
 */
const informationBlock = z.object({
  type: z.literal('information'),
  id: blockId,
  informationId: elementId,
});

const dividerBlock = z.object({ type: z.literal('divider'), id: blockId });
const spacerBlock = z.object({
  type: z.literal('spacer'),
  id: blockId,
  height: millimetres(1, 150).default(5),
});
const pageBreakBlock = z.object({ type: z.literal('page_break'), id: blockId });

/** Every block that may stand in a row's column: anything but another row or a page break. */
const leafBlock = z.discriminatedUnion('type', [
  headingBlock,
  textBlock,
  fieldBlock,
  checkboxBlock,
  optionsBlock,
  fieldsTableBlock,
  repeatTableBlock,
  staticTableBlock,
  imageBlock,
  qrBlock,
  informationBlock,
  dividerBlock,
  spacerBlock,
]);

const rowBlock = z.object({
  type: z.literal('row'),
  id: blockId,
  columns: z
    .array(
      z.object({
        /** Relative width: 1 and 2 make one third and two thirds. */
        width: z.number().int().min(1).max(12).default(1),
        blocks: z.array(leafBlock).max(DESIGN_LIMITS.blocks),
      }),
    )
    .min(2)
    .max(DESIGN_LIMITS.rowColumns),
});

export const blockSchema = z.discriminatedUnion('type', [
  headingBlock,
  textBlock,
  fieldBlock,
  checkboxBlock,
  optionsBlock,
  fieldsTableBlock,
  repeatTableBlock,
  staticTableBlock,
  imageBlock,
  qrBlock,
  informationBlock,
  dividerBlock,
  spacerBlock,
  pageBreakBlock,
  rowBlock,
]);
export type Block = z.infer<typeof blockSchema>;
export type LeafBlock = z.infer<typeof leafBlock>;
export type BlockType = Block['type'];

export const designSchema = z.object({
  schemaVersion: z.literal(DESIGN_SCHEMA_VERSION),
  page: pageSchema,
  style: styleSchema.default(CLASSIC_STYLE),
  fields: z.array(documentFieldSchema).max(DESIGN_LIMITS.fields).default([]),
  blocks: z.array(blockSchema).max(DESIGN_LIMITS.blocks),
});
export type TemplateDesign = z.infer<typeof designSchema>;

/** One thing wrong with a design, with where it is. */
export interface DesignIssue {
  path: string;
  code:
    | 'invalid'
    | 'too_many_blocks'
    | 'duplicate_block_id'
    | 'duplicate_field_key'
    | 'lookup_roles'
    | 'unknown_field'
    | 'wrong_field_type'
    | 'unknown_option'
    | 'not_repeating'
    | 'outside_section'
    | 'text_too_long';
  message: string;
}

export type DesignResult =
  { ok: true; design: TemplateDesign } | { ok: false; issues: DesignIssue[] };

/**
 * A new template: comfortable margins, page numbers, the company's colour,
 * a heading with the form's title.
 */
export function emptyDesign(): TemplateDesign {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: { top: 20, end: 15, bottom: 20, start: 15 },
      background: null,
      firstPage: null,
      language: null,
      fontSize: 10,
      header: null,
      footer: DEFAULT_FOOTER,
    },
    style: {
      brandColour: 'company',
      font: 'noto-sans',
      tableLines: 'light',
      stripedRows: false,
      headerShading: true,
    },
    fields: [],
    blocks: [
      {
        type: 'heading',
        id: 'title',
        text: { en: '{{form.title}}', ar: '{{form.title}}' },
        level: 1,
        align: 'start',
      },
    ],
  };
}

/** Every block, rows' columns included, in reading order. */
export function allBlocks(design: Pick<TemplateDesign, 'blocks'>): (Block | LeafBlock)[] {
  const out: (Block | LeafBlock)[] = [];
  for (const block of design.blocks) {
    out.push(block);
    if (block.type === 'row') {
      for (const column of block.columns) {
        out.push(...column.blocks);
      }
    }
  }
  return out;
}

/**
 * A version 1 design as version 2, printing exactly as before: portrait, no
 * header, black headings, the Noto fonts, and its footer — page numbers at
 * the end, its line of text at the start — in the three places. Anything that
 * is not a version 1 design is returned as it is.
 */
export function upgradeDesign(input: unknown): unknown {
  if (
    input === null ||
    typeof input !== 'object' ||
    (input as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    return input;
  }
  const v1 = input as { page?: unknown };
  const page =
    v1.page !== null && typeof v1.page === 'object' ? (v1.page as Record<string, unknown>) : {};
  const footer =
    page.footer !== null && typeof page.footer === 'object'
      ? (page.footer as { pageNumbers?: unknown; text?: unknown })
      : {};
  const text = footer.text;
  const hasText =
    text !== null &&
    typeof text === 'object' &&
    Object.values(text as Record<string, unknown>).some(
      (value) => typeof value === 'string' && value !== '',
    );
  const rest = Object.fromEntries(Object.entries(page).filter(([key]) => key !== 'footer'));
  return {
    ...(input as Record<string, unknown>),
    schemaVersion: DESIGN_SCHEMA_VERSION,
    page: {
      ...rest,
      orientation: 'portrait',
      header: null,
      footer: {
        start: hasText ? { kind: 'text', text, bold: false } : null,
        center: null,
        end: footer.pageNumbers === false ? null : { kind: 'page' },
        notOnFirstPage: false,
      },
    },
    style: CLASSIC_STYLE,
  };
}

/** Structural validation: the shape, the limits and the rules within the design itself. */
export function parseDesign(input: unknown): DesignResult {
  const parsed = designSchema.safeParse(upgradeDesign(input));
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        code: 'invalid' as const,
        message: issue.message,
      })),
    };
  }
  const design = parsed.data;
  const issues: DesignIssue[] = [];
  const blocks = allBlocks(design);
  if (blocks.length > DESIGN_LIMITS.blocks) {
    issues.push({
      path: 'blocks',
      code: 'too_many_blocks',
      message: `A template holds at most ${String(DESIGN_LIMITS.blocks)} blocks.`,
    });
  }
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) {
      issues.push({
        path: `blocks.${block.id}`,
        code: 'duplicate_block_id',
        message: `Two blocks share the id "${block.id}".`,
      });
    }
    seen.add(block.id);
    for (const value of textsOf(block)) {
      for (const content of Object.values(value)) {
        if (content.length > DESIGN_LIMITS.textLength) {
          issues.push({
            path: `blocks.${block.id}`,
            code: 'text_too_long',
            message: `Text is limited to ${String(DESIGN_LIMITS.textLength)} characters.`,
          });
        }
      }
    }
  }
  for (const [name, band] of [
    ['header', design.page.header],
    ['footer', design.page.footer],
  ] as const) {
    for (const slot of band === null ? [] : [band.start, band.center, band.end]) {
      if (
        slot?.kind === 'text' &&
        Object.values(slot.text).some((content) => content.length > BAND_TEXT_LENGTH)
      ) {
        issues.push({
          path: `page.${name}`,
          code: 'text_too_long',
          message: `A header or footer text is limited to ${String(BAND_TEXT_LENGTH)} characters.`,
        });
      }
    }
  }
  const keys = new Set<string>();
  for (const field of design.fields) {
    if (keys.has(field.key)) {
      issues.push({
        path: `fields.${field.key}`,
        code: 'duplicate_field_key',
        message: `Two document fields share the key "${field.key}".`,
      });
    }
    keys.add(field.key);
  }
  const lookupKeys = design.fields.filter((field) => field.lookup === 'key').length;
  const confirmations = design.fields.filter((field) => field.lookup === 'confirm').length;
  if (lookupKeys > 1 || confirmations > 1 || (confirmations === 1 && lookupKeys === 0)) {
    issues.push({
      path: 'fields',
      code: 'lookup_roles',
      message:
        'A template has at most one website lookup field, and at most one second field, which needs the first.',
    });
  }
  return issues.length === 0 ? { ok: true, design } : { ok: false, issues };
}

/**
 * Checks a parsed design against the form it belongs to: every field it names
 * exists and is of a kind the block can show. Run when a template is saved,
 * against the form's latest published version.
 */
export function checkDesignAgainstForm(design: TemplateDesign, form: CompiledForm): DesignIssue[] {
  const issues: DesignIssue[] = [];
  const field = (path: string, id: string): Field | undefined => {
    const element = form.elements.get(id);
    if (element?.field === undefined) {
      issues.push({ path, code: 'unknown_field', message: `The form has no field "${id}".` });
      return undefined;
    }
    return element.field;
  };
  const topLevel = (path: string, id: string): Field | undefined => {
    const found = field(path, id);
    if (found !== undefined && form.elements.get(id)?.entries !== undefined) {
      issues.push({
        path,
        code: 'outside_section',
        message: `"${id}" is inside a repeating section; show it with a table of that section.`,
      });
      return undefined;
    }
    return found;
  };
  const wrongType = (path: string, id: string, expected: string) => {
    issues.push({
      path,
      code: 'wrong_field_type',
      message: `"${id}" cannot be shown this way; it needs ${expected}.`,
    });
  };

  for (const documentField of design.fields) {
    if (documentField.source.kind === 'answer') {
      topLevel(`fields.${documentField.key}`, documentField.source.fieldId);
    }
  }

  for (const block of allBlocks(design)) {
    const path = `blocks.${block.id}`;
    switch (block.type) {
      case 'field':
        topLevel(path, block.fieldId);
        break;
      case 'checkbox': {
        const found = topLevel(path, block.fieldId);
        if (found === undefined) {
          break;
        }
        if (found.type === 'checkbox') {
          break;
        }
        if (found.type === 'yes_no') {
          if (
            block.option !== undefined &&
            !['yes', 'no', 'not_applicable'].includes(block.option)
          ) {
            issues.push({
              path,
              code: 'unknown_option',
              message: 'A yes/no box ticks on yes, no or not_applicable.',
            });
          }
          break;
        }
        if (found.type === 'dropdown' || found.type === 'radio' || found.type === 'multi_select') {
          if (
            block.option === undefined ||
            !found.options.some((option) => option.value === block.option)
          ) {
            issues.push({
              path,
              code: 'unknown_option',
              message: `"${block.fieldId}" has no option "${block.option ?? ''}".`,
            });
          }
          break;
        }
        wrongType(path, block.fieldId, 'a checkbox, yes/no or choice field');
        break;
      }
      case 'options': {
        const found = topLevel(path, block.fieldId);
        if (
          found !== undefined &&
          !['dropdown', 'radio', 'multi_select', 'yes_no', 'checkbox'].includes(found.type)
        ) {
          wrongType(path, block.fieldId, 'a choice, yes/no or checkbox field');
        }
        break;
      }
      case 'fields_table':
        for (const row of block.rows) {
          topLevel(path, row.fieldId);
        }
        break;
      case 'repeat_table': {
        const section = form.elements.get(block.sectionId);
        if (section?.kind !== 'section' || section.repeat === undefined) {
          issues.push({
            path,
            code: 'not_repeating',
            message: `"${block.sectionId}" is not a repeating section of the form.`,
          });
          break;
        }
        for (const column of block.columns) {
          const found = field(path, column.fieldId);
          if (
            found !== undefined &&
            form.elements.get(column.fieldId)?.entries !== block.sectionId
          ) {
            issues.push({
              path,
              code: 'outside_section',
              message: `"${column.fieldId}" is not a field of "${block.sectionId}".`,
            });
          }
        }
        break;
      }
      case 'information': {
        const element = form.elements.get(block.informationId);
        if (element?.information === undefined) {
          issues.push({
            path,
            code: 'unknown_field',
            message: `The form has no Information block "${block.informationId}".`,
          });
        } else if (element.entries !== undefined) {
          issues.push({
            path,
            code: 'outside_section',
            message: `"${block.informationId}" is inside a repeating section, and prints only outside one.`,
          });
        }
        break;
      }
      case 'image':
        if (block.source.kind === 'answer') {
          const found = topLevel(path, block.source.fieldId);
          if (found !== undefined && found.type !== 'photo' && found.type !== 'signature') {
            wrongType(path, block.source.fieldId, 'a photo or signature field');
          }
        }
        break;
      default:
        break;
    }
  }
  return issues;
}

/** Whether the design shows the company's logo anywhere: a block, the header or the footer. */
export function designUsesLogo(design: TemplateDesign): boolean {
  const inBand = (band: HeaderFooterSpec | null) =>
    band !== null &&
    !bandIsEmpty(band) &&
    [band.start, band.center, band.end].some((slot) => slot?.kind === 'logo');
  return (
    inBand(design.page.header) ||
    inBand(design.page.footer) ||
    allBlocks(design).some((block) => block.type === 'image' && block.source.kind === 'logo')
  );
}

/**
 * The blocks and document fields a list of issues names, for the designer to
 * mark: `blocks.<id>` and `fields.<key>`.
 */
export function issueTargets(issues: readonly Pick<DesignIssue, 'path'>[]): {
  blocks: Set<string>;
  fields: Set<string>;
} {
  const blocks = new Set<string>();
  const fields = new Set<string>();
  for (const issue of issues) {
    const [scope, id] = issue.path.split('.');
    if (scope === 'blocks' && id !== undefined) {
      blocks.add(id);
    } else if (scope === 'fields' && id !== undefined) {
      fields.add(id);
    }
  }
  return { blocks, fields };
}

/** Every uploaded image a design uses: backgrounds and image blocks. */
export function designFileIds(design: TemplateDesign): string[] {
  const ids = new Set<string>();
  if (design.page.background !== null) {
    ids.add(design.page.background.fileId);
  }
  if (design.page.firstPage?.background != null) {
    ids.add(design.page.firstPage.background.fileId);
  }
  for (const block of allBlocks(design)) {
    if (block.type === 'image' && block.source.kind === 'file') {
      ids.add(block.source.fileId);
    }
  }
  return [...ids];
}

/** Every photo or signature field whose images a design shows. */
export function designMediaFields(design: TemplateDesign, form: CompiledForm): string[] {
  const ids = new Set<string>();
  const imageField = (id: string) => {
    const type = form.elements.get(id)?.field?.type;
    if (type === 'photo' || type === 'signature') {
      ids.add(id);
    }
  };
  for (const block of allBlocks(design)) {
    if (block.type === 'image' && block.source.kind === 'answer') {
      imageField(block.source.fieldId);
    } else if (block.type === 'field') {
      imageField(block.fieldId);
    } else if (block.type === 'fields_table') {
      block.rows.forEach((row) => {
        imageField(row.fieldId);
      });
    } else if (block.type === 'repeat_table') {
      block.columns.forEach((column) => {
        imageField(column.fieldId);
      });
    }
  }
  return [...ids];
}

function textsOf(block: Block | LeafBlock): LocalizedText[] {
  switch (block.type) {
    case 'heading':
    case 'text':
      return [block.text];
    case 'static_table':
      return [...block.header, ...block.rows.flat()];
    default:
      return [];
  }
}
