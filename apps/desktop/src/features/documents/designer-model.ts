import {
  type Block,
  type BlockType,
  type DocumentField,
  type LeafBlock,
  type TemplateDesign,
  wordsFor,
} from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';

/**
 * The PDF designer's arithmetic (docs/documents ADR-0001 D1, D2): new blocks
 * and fields with sensible defaults and fresh ids, moving them, and the
 * questions of the form each kind of block can show.
 */

export type LocalizedText = Record<string, string>;

/** Every block type the "Add" menu offers at the top level, in the order it lists them. */
export const BLOCK_TYPES: readonly BlockType[] = [
  'heading',
  'text',
  'field',
  'checkbox',
  'options',
  'fields_table',
  'repeat_table',
  'static_table',
  'image',
  'qr',
  'information',
  'divider',
  'spacer',
  'page_break',
  'row',
];

/** What may stand in a column of a row: anything but a row or a page break. */
export const LEAF_TYPES: readonly LeafBlock['type'][] = BLOCK_TYPES.filter(
  (type): type is LeafBlock['type'] => type !== 'row' && type !== 'page_break',
);

/** An id no block in the design has yet: `text_3`, `qr_1`. */
export function freshBlockId(design: Pick<TemplateDesign, 'blocks'>, type: BlockType): string {
  const used = new Set<string>();
  const visit = (blocks: readonly (Block | LeafBlock)[]) => {
    for (const block of blocks) {
      used.add(block.id);
      if (block.type === 'row') {
        block.columns.forEach((column) => {
          visit(column.blocks);
        });
      }
    }
  };
  visit(design.blocks);
  for (let number = 1; ; number += 1) {
    const id = `${type.replace(/_/gu, '-')}-${String(number)}`;
    if (!used.has(id)) {
      return id;
    }
  }
}

/** A new block of a type, filled in enough to be valid where it can be. */
export function newBlock(type: BlockType, id: string, form: CompiledForm | null): Block {
  const first = (types: readonly string[]) => questions(form, types)[0]?.id ?? '';
  switch (type) {
    case 'heading':
      return {
        type,
        id,
        text: { en: '{{form.title}}', ar: '{{form.title}}' },
        level: 2,
        align: 'start',
      };
    case 'text':
      return {
        type,
        id,
        text: { en: '{{company.name}}', ar: '{{company.name}}' },
        align: 'start',
        size: 'normal',
        bold: false,
      };
    case 'field':
      return { type, id, fieldId: first([]), layout: 'inline' };
    case 'checkbox':
      return { type, id, fieldId: first(['checkbox', 'yes_no']) };
    case 'options':
      return { type, id, fieldId: first(CHOICE_TYPES), columns: 2 };
    case 'fields_table':
      return { type, id, rows: [{ fieldId: first([]) }] };
    case 'repeat_table': {
      const section = repeatingSections(form)[0];
      const column = section === undefined ? '' : (sectionFields(form, section.id)[0]?.id ?? '');
      return {
        type,
        id,
        sectionId: section?.id ?? '',
        columns: [{ fieldId: column }],
        numbered: true,
      };
    }
    case 'static_table':
      return { type, id, header: [], rows: [[{ en: '—', ar: '—' }]] };
    case 'image':
      return { type, id, source: { kind: 'logo' }, width: 40, align: 'start' };
    case 'qr':
      return { type, id, size: 30, align: 'end' };
    case 'information':
      return { type, id, informationId: informationBlocks(form)[0]?.id ?? '' };
    case 'divider':
      return { type, id };
    case 'spacer':
      return { type, id, height: 5 };
    case 'page_break':
      return { type, id };
    case 'row':
      return {
        type,
        id,
        columns: [
          { width: 1, blocks: [] },
          { width: 1, blocks: [] },
        ],
      };
  }
}

/** A new document field, typed by the person by default, with an unused key. */
export function newField(fields: readonly DocumentField[]): DocumentField {
  const used = new Set(fields.map((field) => field.key));
  let number = fields.length + 1;
  while (used.has(`field_${String(number)}`)) {
    number += 1;
  }
  return {
    key: `field_${String(number)}`,
    label: { en: `Field ${String(number)}` },
    source: { kind: 'typed', required: false, maxLength: 100 },
    lookup: 'none',
  };
}

/** The list with one item moved by `by` places; unchanged at either end. */
export function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by;
  if (target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
}

export const CHOICE_TYPES = ['dropdown', 'radio', 'multi_select', 'yes_no', 'checkbox'];
export const IMAGE_TYPES = ['photo', 'signature'];

export interface Question {
  id: string;
  label: LocalizedText;
  type: string;
  /** The repeating section it belongs to, if any: its answers are in entries. */
  section: string | undefined;
}

/** The form's questions of the given types (any, when empty), outside repeating sections unless asked. */
export function questions(
  form: CompiledForm | null,
  types: readonly string[] = [],
  options: { includeRepeating?: boolean } = {},
): Question[] {
  if (form === null) {
    return [];
  }
  return form.fields.flatMap((field) => {
    const info = form.elements.get(field.id);
    if (info === undefined) {
      return [];
    }
    if (info.entries !== undefined && options.includeRepeating !== true) {
      return [];
    }
    if (types.length > 0 && !types.includes(field.type)) {
      return [];
    }
    return [
      {
        id: field.id,
        label: field.label,
        type: field.type,
        section: info.entries,
      },
    ];
  });
}

/**
 * The form's Information blocks (form schema version 2) that can be printed:
 * those outside repeating sections, each named by its heading or first words.
 */
export function informationBlocks(
  form: CompiledForm | null,
): { id: string; heading: LocalizedText | undefined; body: LocalizedText }[] {
  if (form === null) {
    return [];
  }
  return [...form.elements.values()].flatMap((element) =>
    element.information === undefined || element.entries !== undefined
      ? []
      : [
          {
            id: element.id,
            heading: element.information.heading,
            body: element.information.body,
          },
        ],
  );
}

/** The form's repeating sections. */
export function repeatingSections(
  form: CompiledForm | null,
): { id: string; title: LocalizedText }[] {
  if (form === null) {
    return [];
  }
  return form.definition.pages.flatMap((page) =>
    page.sections
      .filter((section) => section.repeat !== undefined)
      .map((section) => ({ id: section.id, title: section.title ?? {} })),
  );
}

/** The questions inside one repeating section. */
export function sectionFields(form: CompiledForm | null, sectionId: string): Question[] {
  return questions(form, [], { includeRepeating: true }).filter(
    (question) => question.section === sectionId,
  );
}

/** A choice question's options, as values and labels; yes/no answers as theirs. */
export function optionsOf(
  form: CompiledForm | null,
  fieldId: string,
): { value: string; label: LocalizedText }[] {
  const field = form?.elements.get(fieldId)?.field;
  if (field === undefined) {
    return [];
  }
  if (field.type === 'yes_no') {
    const [en, ar] = [wordsFor('en'), wordsFor('ar')];
    return [
      { value: 'yes', label: { en: en.yes, ar: ar.yes } },
      { value: 'no', label: { en: en.no, ar: ar.no } },
      { value: 'not_applicable', label: { en: en.notApplicable, ar: ar.notApplicable } },
    ];
  }
  if ('options' in field) {
    return field.options.map((option) => ({
      value: option.value,
      label: option.label,
    }));
  }
  return [];
}
