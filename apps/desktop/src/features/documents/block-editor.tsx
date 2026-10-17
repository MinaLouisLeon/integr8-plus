import type { Block, BlockType, LeafBlock, TemplateDesign } from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useState } from 'react';
import { Button } from '~/components/ui';
import {
  CheckInput,
  ImageUpload,
  LocalizedInputs,
  NumberInput,
  QuestionInput,
  SelectInput,
} from './designer-inputs';
import {
  BLOCK_TYPES,
  CHOICE_TYPES,
  freshBlockId,
  IMAGE_TYPES,
  LEAF_TYPES,
  moved,
  newBlock,
  optionsOf,
  questions,
  repeatingSections,
  sectionFields,
} from './designer-model';

/**
 * The designer's content: the blocks of a template, one under another, each
 * opened to edit in place (docs/documents ADR-0001 D2). A row's columns hold
 * blocks of their own, edited the same way.
 */

type AnyBlock = Block | LeafBlock;

const PLACEHOLDERS = [
  '{{answer.<question>}}',
  '{{field.<key>}}',
  '{{company.name}}',
  '{{form.title}}',
  '{{submission.date}}',
  '{{submission.submitted_by}}',
  '{{document.date}}',
  '{{work_order.reference}}',
  '{{asset.reference}}',
];

interface Context {
  /** The whole design, for fresh ids. */
  design: TemplateDesign;
  form: CompiledForm | null;
  locale: string;
}

export function BlockList({
  blocks,
  onChange,
  context,
  leafOnly = false,
}: {
  blocks: readonly AnyBlock[];
  onChange: (blocks: AnyBlock[]) => void;
  context: Context;
  leafOnly?: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<BlockType>(leafOnly ? 'text' : 'heading');
  const [open, setOpen] = useState<string | null>(null);
  const types = leafOnly ? LEAF_TYPES : BLOCK_TYPES;

  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, index) => (
        <div key={block.id} className="rounded-md border border-border-subtle bg-surface">
          <div className="flex flex-wrap items-center gap-2 px-3 py-2">
            <span className="text-sm font-medium text-content">
              {t(`documents.designer.block.types.${block.type}`)}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-content-muted" dir="auto">
              {summary(block, context.locale)}
            </span>
            <Button
              variant="ghost"
              aria-label={t('documents.designer.block.moveUp')}
              disabled={index === 0}
              onClick={() => onChange(moved(blocks, index, -1))}
            >
              ↑
            </Button>
            <Button
              variant="ghost"
              aria-label={t('documents.designer.block.moveDown')}
              disabled={index === blocks.length - 1}
              onClick={() => onChange(moved(blocks, index, 1))}
            >
              ↓
            </Button>
            {hasSettings(block) ? (
              <Button
                variant="secondary"
                aria-expanded={open === block.id}
                onClick={() => setOpen(open === block.id ? null : block.id)}
              >
                {open === block.id
                  ? t('documents.designer.block.done')
                  : t('documents.designer.block.edit')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => onChange(blocks.filter((candidate) => candidate.id !== block.id))}
            >
              {t('documents.designer.block.remove')}
            </Button>
          </div>
          {open === block.id ? (
            <div className="border-t border-border-subtle px-3 py-3">
              <BlockEditor
                block={block}
                context={context}
                onChange={(next) =>
                  onChange(
                    blocks.map((candidate) => (candidate.id === block.id ? next : candidate)),
                  )
                }
              />
            </div>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48">
          <SelectInput
            label={t('documents.designer.block.add')}
            value={adding}
            options={types.map((type) => ({
              value: type,
              label: t(`documents.designer.block.types.${type}`),
            }))}
            onChange={setAdding}
          />
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            const id = freshBlockId(
              { blocks: [...context.design.blocks, ...blocks] as Block[] },
              adding,
            );
            onChange([...blocks, newBlock(adding, id, context.form)]);
            setOpen(id);
          }}
        >
          {t('documents.designer.block.add')}
        </Button>
      </div>
    </div>
  );
}

function hasSettings(block: AnyBlock): boolean {
  return block.type !== 'divider' && block.type !== 'page_break';
}

function summary(block: AnyBlock, locale: string): string {
  const language = locale.startsWith('ar') ? 'ar' : 'en';
  switch (block.type) {
    case 'heading':
    case 'text':
      return block.text[language] ?? block.text.en ?? '';
    case 'field':
    case 'checkbox':
    case 'options':
      return block.fieldId;
    case 'fields_table':
      return block.rows.map((row) => row.fieldId).join(', ');
    case 'repeat_table':
      return block.sectionId;
    case 'image':
      return block.source.kind === 'answer' ? block.source.fieldId : block.source.kind;
    case 'row':
      return block.columns.map((column) => String(column.blocks.length)).join(' | ');
    default:
      return '';
  }
}

function BlockEditor({
  block,
  onChange,
  context,
}: {
  block: AnyBlock;
  onChange: (block: AnyBlock) => void;
  context: Context;
}) {
  const { t } = useTranslation();
  const { form, locale } = context;
  const align = (
    value: 'start' | 'center' | 'end' | undefined,
    set: (v: 'start' | 'center' | 'end') => void,
  ) => (
    <SelectInput
      label={t('documents.designer.block.align')}
      value={value ?? 'start'}
      options={[
        { value: 'start', label: t('documents.designer.block.alignStart') },
        { value: 'center', label: t('documents.designer.block.alignCenter') },
        { value: 'end', label: t('documents.designer.block.alignEnd') },
      ]}
      onChange={set}
    />
  );
  const labelInputs = (
    value: Record<string, string> | undefined,
    set: (value: Record<string, string> | undefined) => void,
    kind: 'label' | 'title' | 'caption',
  ) => (
    <LocalizedInputs
      optional
      labels={{
        en: t(`documents.designer.block.${kind}En`),
        ar: t(`documents.designer.block.${kind}Ar`),
      }}
      value={value}
      onChange={set}
    />
  );
  const grid = 'grid grid-cols-1 gap-3 lg:grid-cols-2';

  switch (block.type) {
    case 'heading':
      return (
        <div className="flex flex-col gap-3">
          <LocalizedInputs
            labels={{
              en: t('documents.designer.block.textEn'),
              ar: t('documents.designer.block.textAr'),
            }}
            value={block.text}
            onChange={(text) => onChange({ ...block, text: text ?? {} })}
          />
          <div className={grid}>
            <SelectInput
              label={t('documents.designer.block.level')}
              value={String(block.level) as '1' | '2' | '3'}
              options={[
                { value: '1', label: 'H1' },
                { value: '2', label: 'H2' },
                { value: '3', label: 'H3' },
              ]}
              onChange={(level) => onChange({ ...block, level: Number(level) as 1 | 2 | 3 })}
            />
            {align(block.align, (value) => onChange({ ...block, align: value }))}
          </div>
          <Placeholders />
        </div>
      );
    case 'text':
      return (
        <div className="flex flex-col gap-3">
          <LocalizedInputs
            multiline
            labels={{
              en: t('documents.designer.block.textEn'),
              ar: t('documents.designer.block.textAr'),
            }}
            value={block.text}
            onChange={(text) => onChange({ ...block, text: text ?? {} })}
          />
          <div className={grid}>
            {align(block.align, (value) => onChange({ ...block, align: value }))}
            <SelectInput
              label={t('documents.designer.block.size')}
              value={block.size}
              options={[
                { value: 'small', label: t('documents.designer.block.sizeSmall') },
                { value: 'normal', label: t('documents.designer.block.sizeNormal') },
                { value: 'large', label: t('documents.designer.block.sizeLarge') },
              ]}
              onChange={(size) => onChange({ ...block, size })}
            />
          </div>
          <CheckInput
            label={t('documents.designer.block.bold')}
            checked={block.bold}
            onChange={(bold) => onChange({ ...block, bold })}
          />
          <Placeholders />
        </div>
      );
    case 'field':
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <QuestionInput
              label={t('documents.designer.block.question')}
              value={block.fieldId}
              questions={questions(form)}
              locale={locale}
              onChange={(fieldId) => onChange({ ...block, fieldId })}
            />
            <SelectInput
              label={t('documents.designer.block.layout')}
              value={block.layout}
              options={[
                { value: 'inline', label: t('documents.designer.block.layoutInline') },
                { value: 'stacked', label: t('documents.designer.block.layoutStacked') },
                { value: 'value_only', label: t('documents.designer.block.layoutValue') },
              ]}
              onChange={(layout) => onChange({ ...block, layout })}
            />
          </div>
          {labelInputs(
            block.label,
            (label) => onChange(withOptional(block, 'label', label)),
            'label',
          )}
        </div>
      );
    case 'checkbox': {
      const field = form?.elements.get(block.fieldId)?.field;
      const options = optionsOf(form, block.fieldId);
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <QuestionInput
              label={t('documents.designer.block.question')}
              value={block.fieldId}
              questions={questions(form, CHOICE_TYPES)}
              locale={locale}
              onChange={(fieldId) => onChange({ type: block.type, id: block.id, fieldId })}
            />
            {field === undefined || field.type === 'checkbox' ? null : (
              <SelectInput
                label={t('documents.designer.block.option')}
                value={block.option ?? (field.type === 'yes_no' ? 'yes' : '')}
                placeholder={t('documents.designer.block.choose')}
                options={options.map((option) => ({
                  value: option.value,
                  label: option.label[locale.startsWith('ar') ? 'ar' : 'en'] ?? option.value,
                }))}
                onChange={(option) => onChange({ ...block, option })}
              />
            )}
          </div>
          {labelInputs(
            block.label,
            (label) => onChange(withOptional(block, 'label', label)),
            'label',
          )}
        </div>
      );
    }
    case 'options':
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <QuestionInput
              label={t('documents.designer.block.question')}
              value={block.fieldId}
              questions={questions(form, CHOICE_TYPES)}
              locale={locale}
              onChange={(fieldId) => onChange({ ...block, fieldId })}
            />
            <SelectInput
              label={t('documents.designer.block.columns')}
              value={String(block.columns) as '1' | '2' | '3' | '4'}
              options={(['1', '2', '3', '4'] as const).map((value) => ({ value, label: value }))}
              onChange={(columns) =>
                onChange({ ...block, columns: Number(columns) as 1 | 2 | 3 | 4 })
              }
            />
          </div>
          {labelInputs(
            block.label,
            (label) => onChange(withOptional(block, 'label', label)),
            'label',
          )}
        </div>
      );
    case 'fields_table':
      return (
        <div className="flex flex-col gap-3">
          {labelInputs(
            block.title,
            (title) => onChange(withOptional(block, 'title', title)),
            'title',
          )}
          <span className="text-xs font-medium text-content-muted">
            {t('documents.designer.block.rows')}
          </span>
          {block.rows.map((row, index) => (
            <div key={index} className="flex items-end gap-2">
              <div className="flex-1">
                <QuestionInput
                  label={`${t('documents.designer.block.question')} ${String(index + 1)}`}
                  value={row.fieldId}
                  questions={questions(form)}
                  locale={locale}
                  onChange={(fieldId) =>
                    onChange({
                      ...block,
                      rows: block.rows.map((candidate, at) =>
                        at === index ? { ...candidate, fieldId } : candidate,
                      ),
                    })
                  }
                />
              </div>
              <Button
                variant="ghost"
                disabled={block.rows.length === 1}
                onClick={() =>
                  onChange({ ...block, rows: block.rows.filter((_row, at) => at !== index) })
                }
              >
                {t('documents.designer.block.removeItem')}
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                onChange({
                  ...block,
                  rows: [...block.rows, { fieldId: questions(form)[0]?.id ?? '' }],
                })
              }
            >
              {t('documents.designer.block.addRow')}
            </Button>
          </div>
        </div>
      );
    case 'repeat_table': {
      const columns = sectionFields(form, block.sectionId);
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <SelectInput
              label={t('documents.designer.block.section')}
              value={block.sectionId}
              placeholder={t('documents.designer.block.choose')}
              options={repeatingSections(form).map((section) => ({
                value: section.id,
                label: section.title[locale.startsWith('ar') ? 'ar' : 'en'] ?? section.id,
              }))}
              onChange={(sectionId) =>
                onChange({
                  ...block,
                  sectionId,
                  columns: [{ fieldId: sectionFields(form, sectionId)[0]?.id ?? '' }],
                })
              }
            />
            <CheckInput
              label={t('documents.designer.block.numbered')}
              checked={block.numbered}
              onChange={(numbered) => onChange({ ...block, numbered })}
            />
          </div>
          {labelInputs(
            block.title,
            (title) => onChange(withOptional(block, 'title', title)),
            'title',
          )}
          {block.columns.map((column, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <QuestionInput
                  label={t('documents.designer.block.column', { number: index + 1 })}
                  value={column.fieldId}
                  questions={columns}
                  locale={locale}
                  onChange={(fieldId) =>
                    onChange({
                      ...block,
                      columns: block.columns.map((candidate, at) =>
                        at === index ? { ...candidate, fieldId } : candidate,
                      ),
                    })
                  }
                />
              </div>
              <div className="w-28">
                <NumberInput
                  label={t('documents.designer.block.width')}
                  value={column.width ?? null}
                  min={5}
                  max={100}
                  onChange={(width) =>
                    onChange({
                      ...block,
                      columns: block.columns.map((candidate, at) =>
                        at === index
                          ? withOptional(candidate, 'width', width ?? undefined)
                          : candidate,
                      ),
                    })
                  }
                />
              </div>
              <Button
                variant="ghost"
                disabled={block.columns.length === 1}
                onClick={() =>
                  onChange({ ...block, columns: block.columns.filter((_c, at) => at !== index) })
                }
              >
                {t('documents.designer.block.removeItem')}
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              disabled={block.columns.length >= 8}
              onClick={() =>
                onChange({
                  ...block,
                  columns: [...block.columns, { fieldId: columns[0]?.id ?? '' }],
                })
              }
            >
              {t('documents.designer.block.addColumn')}
            </Button>
          </div>
        </div>
      );
    }
    case 'static_table': {
      const width = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
      const setCell = (row: number, column: number, value: Record<string, string> | undefined) =>
        onChange({
          ...block,
          rows: block.rows.map((cells, at) =>
            at === row
              ? Array.from({ length: width }, (_unused, index) =>
                  index === column ? (value ?? {}) : (cells[index] ?? {}),
                )
              : cells,
          ),
        });
      return (
        <div className="flex flex-col gap-3">
          {labelInputs(
            block.title,
            (title) => onChange(withOptional(block, 'title', title)),
            'title',
          )}
          <CheckInput
            label={t('documents.designer.block.header')}
            checked={block.header.length > 0}
            onChange={(on) =>
              onChange({
                ...block,
                header: on ? Array.from({ length: width }, () => ({ en: '—', ar: '—' })) : [],
              })
            }
          />
          {block.header.length === 0 ? null : (
            <div className="flex flex-col gap-2 rounded-md bg-surface-muted p-2">
              {block.header.map((cell, column) => (
                <LocalizedInputs
                  key={column}
                  labels={{
                    en: `${t('documents.designer.block.column', { number: column + 1 })} · ${t('documents.designer.block.textEn')}`,
                    ar: `${t('documents.designer.block.column', { number: column + 1 })} · ${t('documents.designer.block.textAr')}`,
                  }}
                  value={cell}
                  onChange={(value) =>
                    onChange({
                      ...block,
                      header: block.header.map((candidate, at) =>
                        at === column ? (value ?? {}) : candidate,
                      ),
                    })
                  }
                />
              ))}
            </div>
          )}
          {block.rows.map((cells, row) => (
            <div
              key={row}
              className="flex flex-col gap-2 rounded-md border border-border-subtle p-2"
            >
              {Array.from({ length: width }, (_unused, column) => (
                <LocalizedInputs
                  key={column}
                  labels={{
                    en: `${t('documents.designer.block.cell')} ${String(row + 1)}.${String(column + 1)} · ${t('documents.designer.block.textEn')}`,
                    ar: `${t('documents.designer.block.cell')} ${String(row + 1)}.${String(column + 1)} · ${t('documents.designer.block.textAr')}`,
                  }}
                  value={cells[column]}
                  onChange={(value) => setCell(row, column, value)}
                />
              ))}
              <div>
                <Button
                  variant="ghost"
                  disabled={block.rows.length === 1}
                  onClick={() =>
                    onChange({ ...block, rows: block.rows.filter((_r, at) => at !== row) })
                  }
                >
                  {t('documents.designer.block.removeItem')}
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() =>
                onChange({
                  ...block,
                  rows: [
                    ...block.rows,
                    Array.from({ length: width }, () => ({ en: '—', ar: '—' })),
                  ],
                })
              }
            >
              {t('documents.designer.block.addRow')}
            </Button>
            <Button
              variant="secondary"
              disabled={width >= 8}
              onClick={() =>
                onChange({
                  ...block,
                  header: block.header.length === 0 ? [] : [...block.header, { en: '—', ar: '—' }],
                  rows: block.rows.map((cells) => [
                    ...Array.from({ length: width }, (_u, index) => cells[index] ?? {}),
                    { en: '—', ar: '—' },
                  ]),
                })
              }
            >
              {t('documents.designer.block.addColumn')}
            </Button>
          </div>
        </div>
      );
    }
    case 'image':
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <SelectInput
              label={t('documents.designer.block.source')}
              value={block.source.kind}
              options={[
                { value: 'logo', label: t('documents.designer.block.sourceLogo') },
                { value: 'file', label: t('documents.designer.block.sourceFile') },
                { value: 'answer', label: t('documents.designer.block.sourceAnswer') },
              ]}
              onChange={(kind) =>
                onChange({
                  ...block,
                  source:
                    kind === 'logo'
                      ? { kind }
                      : kind === 'file'
                        ? { kind, fileId: '' }
                        : { kind, fieldId: questions(form, IMAGE_TYPES)[0]?.id ?? '' },
                })
              }
            />
            <NumberInput
              label={t('documents.designer.block.widthMm')}
              value={block.width}
              min={5}
              max={190}
              onChange={(width) => onChange({ ...block, width: width ?? 40 })}
            />
            {align(block.align, (value) => onChange({ ...block, align: value }))}
          </div>
          {block.source.kind === 'file' ? (
            <ImageUpload
              label={t('documents.designer.block.sourceFile')}
              fileId={block.source.fileId === '' ? null : block.source.fileId}
              removable={false}
              onChange={(fileId) =>
                onChange({ ...block, source: { kind: 'file', fileId: fileId ?? '' } })
              }
            />
          ) : null}
          {block.source.kind === 'answer' ? (
            <QuestionInput
              label={t('documents.designer.block.question')}
              value={block.source.fieldId}
              questions={questions(form, IMAGE_TYPES)}
              locale={locale}
              onChange={(fieldId) => onChange({ ...block, source: { kind: 'answer', fieldId } })}
            />
          ) : null}
          {labelInputs(
            block.caption,
            (caption) => onChange(withOptional(block, 'caption', caption)),
            'caption',
          )}
        </div>
      );
    case 'qr':
      return (
        <div className="flex flex-col gap-3">
          <div className={grid}>
            <NumberInput
              label={t('documents.designer.block.qrSize')}
              value={block.size}
              min={15}
              max={80}
              onChange={(size) => onChange({ ...block, size: size ?? 30 })}
            />
            {align(block.align, (value) => onChange({ ...block, align: value }))}
          </div>
          {labelInputs(
            block.caption,
            (caption) => onChange(withOptional(block, 'caption', caption)),
            'caption',
          )}
        </div>
      );
    case 'spacer':
      return (
        <NumberInput
          label={t('documents.designer.block.height')}
          value={block.height}
          min={1}
          max={150}
          onChange={(height) => onChange({ ...block, height: height ?? 5 })}
        />
      );
    case 'row':
      return (
        <div className="flex flex-col gap-4">
          {block.columns.map((column, index) => (
            <div key={index} className="flex flex-col gap-2 rounded-md bg-surface-muted p-2">
              <div className="flex flex-wrap items-end gap-2">
                <span className="text-sm font-medium text-content">
                  {t('documents.designer.block.column', { number: index + 1 })}
                </span>
                <div className="w-32">
                  <NumberInput
                    label={t('documents.designer.block.columnWidth')}
                    value={column.width}
                    min={1}
                    max={12}
                    onChange={(width) =>
                      onChange({
                        ...block,
                        columns: block.columns.map((candidate, at) =>
                          at === index ? { ...candidate, width: width ?? 1 } : candidate,
                        ),
                      })
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  disabled={block.columns.length <= 2}
                  onClick={() =>
                    onChange({ ...block, columns: block.columns.filter((_c, at) => at !== index) })
                  }
                >
                  {t('documents.designer.block.removeItem')}
                </Button>
              </div>
              <BlockList
                leafOnly
                blocks={column.blocks}
                context={context}
                onChange={(blocks) =>
                  onChange({
                    ...block,
                    columns: block.columns.map((candidate, at) =>
                      at === index ? { ...candidate, blocks: blocks as LeafBlock[] } : candidate,
                    ),
                  })
                }
              />
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              disabled={block.columns.length >= 3}
              onClick={() =>
                onChange({ ...block, columns: [...block.columns, { width: 1, blocks: [] }] })
              }
            >
              {t('documents.designer.block.addColumn')}
            </Button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

/** The placeholders a text can hold, written out as they are typed. */
function Placeholders() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1 text-xs text-content-muted">
      <span>{t('documents.designer.block.placeholders')}</span>
      <code dir="ltr" className="flex flex-wrap gap-x-3 gap-y-1">
        {PLACEHOLDERS.map((placeholder) => (
          <span key={placeholder}>{placeholder}</span>
        ))}
      </code>
    </div>
  );
}

/** The object with an optional property set, or removed when `undefined`. */
function withOptional<T extends object, K extends string, V>(
  object: T,
  key: K,
  value: V | undefined,
): T {
  const next = { ...object } as Record<string, unknown>;
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next as T;
}
