import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  type Block,
  BLOCK_COLOURS,
  type BlockType,
  type LeafBlock,
  type TemplateDesign,
} from '@integr8/document-render';
import type { CompiledForm } from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { type ReactNode, useState } from 'react';
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
  informationBlocks,
  LEAF_TYPES,
  moved,
  newBlock,
  optionsOf,
  questions,
  repeatingSections,
  sectionFields,
} from './designer-model';
import { columnContainer, locateBlock, moveBlock, ROOT } from './designer-tree';

/**
 * The designer's content: the blocks of a template, one under another, each
 * opened to edit in place (docs/documents ADR-0001 D2). A row's columns hold
 * blocks of their own, edited the same way.
 *
 * Since 1.3.0 (decision 8) a block is dragged by its handle — within the
 * template, into a row's column and out again — and the arrows stay for the
 * keyboard. A block can be duplicated, or copied to paste into another of the
 * form's templates. A block naming a question the form no longer has is
 * marked, with what to fix.
 */

type AnyBlock = Block | LeafBlock;

/** How a change came about: typing joins into one undo step, anything else is a step of its own. */
export type ChangeKind = 'typing' | 'step';

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

export interface Context {
  /** The whole design, for fresh ids. */
  design: TemplateDesign;
  form: CompiledForm | null;
  locale: string;
  /** Blocks naming a question the form no longer has, with what is wrong with each. */
  attention?: ReadonlyMap<string, string>;
  onDuplicate?: (blockId: string) => void;
  onCopy?: (blockId: string) => void;
}

/** Blocks that may set a text colour and shading (1.3.0 decision 9). */
const WITH_APPEARANCE = new Set<BlockType>([
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
]);

/** Only targets that make sense for what is dragged: a block over a block, else a column. */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args);
  if (within.length > 0) {
    // Prefer a block over the column that holds it.
    return [...within].sort(
      (a, b) =>
        Number(String(a.id).startsWith('col:') || a.id === ROOT) -
        Number(String(b.id).startsWith('col:') || b.id === ROOT),
    );
  }
  return closestCenter(args);
};

/**
 * The whole content of a template: one place to drag within, so a block can
 * go from the template's column into a row's and back.
 */
export function BlockTree({
  blocks,
  onChange,
  context,
}: {
  blocks: readonly Block[];
  onChange: (blocks: Block[], kind: ChangeKind) => void;
  context: Context;
}) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<AnyBlock | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);
    const over = event.over === null ? null : String(event.over.id);
    const active = String(event.active.id);
    if (over === null || over === active) {
      return;
    }
    const target =
      over === ROOT || over.startsWith('col:')
        ? { container: over, index: Number.MAX_SAFE_INTEGER }
        : locateBlock(blocks, over);
    if (target === null) {
      return;
    }
    const next = moveBlock(blocks, active, target);
    if (next !== null) {
      onChange(next, 'step');
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(event: DragStartEvent) =>
        setDragging(findBlock(blocks, String(event.active.id)))
      }
      onDragCancel={() => setDragging(null)}
      onDragEnd={onDragEnd}
    >
      <BlockList
        container={ROOT}
        blocks={blocks}
        context={context}
        onChange={(next, kind) => onChange(next, kind)}
      />
      <DragOverlay dropAnimation={null}>
        {dragging === null ? null : (
          <div className="rounded-md border border-accent bg-surface px-3 py-2 text-sm font-medium text-content shadow-lg">
            {t(`documents.designer.block.types.${dragging.type}`)}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function findBlock(blocks: readonly Block[], id: string): AnyBlock | null {
  for (const block of blocks) {
    if (block.id === id) {
      return block;
    }
    if (block.type === 'row') {
      for (const column of block.columns) {
        const found = column.blocks.find((inner) => inner.id === id);
        if (found !== undefined) {
          return found;
        }
      }
    }
  }
  return null;
}

/** One column of blocks: the template's own, or a row's. Must be inside a {@link BlockTree}. */
export function BlockList({
  blocks,
  onChange,
  context,
  container = ROOT,
}: {
  blocks: readonly AnyBlock[];
  onChange: (blocks: AnyBlock[], kind: ChangeKind) => void;
  context: Context;
  container?: string;
}) {
  const { t } = useTranslation();
  const leafOnly = container !== ROOT;
  const [adding, setAdding] = useState<BlockType>(leafOnly ? 'text' : 'heading');
  const [open, setOpen] = useState<string | null>(null);
  const types = leafOnly ? LEAF_TYPES : BLOCK_TYPES;
  const { setNodeRef, isOver } = useDroppable({ id: container });

  return (
    <div className="flex flex-col gap-2">
      <SortableContext
        items={blocks.map((block) => block.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={[
            'flex min-h-10 flex-col gap-2 rounded-md',
            isOver ? 'outline-2 outline-accent outline-dashed' : '',
          ].join(' ')}
        >
          {blocks.length === 0 ? (
            <p className="px-2 py-3 text-xs text-content-muted">
              {t('documents.pdfBuilder.blocks.dropHere')}
            </p>
          ) : null}
          {blocks.map((block, index) => {
            const problem =
              context.attention?.get(block.id) ??
              (block.type === 'row' &&
              block.columns.some((column) =>
                column.blocks.some((inner) => context.attention?.has(inner.id) === true),
              )
                ? t('documents.pdfBuilder.attention.inRow')
                : undefined);
            return (
              <SortableBlock key={block.id} id={block.id} problem={problem !== undefined}>
                {(handle) => (
                  <>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      {handle}
                      <span className="text-sm font-medium text-content">
                        {t(`documents.designer.block.types.${block.type}`)}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-content-muted"
                        dir="auto"
                      >
                        {summary(block, context.locale)}
                      </span>
                      <Button
                        variant="ghost"
                        aria-label={t('documents.designer.block.moveUp')}
                        disabled={index === 0}
                        onClick={() => onChange(moved(blocks, index, -1), 'step')}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        aria-label={t('documents.designer.block.moveDown')}
                        disabled={index === blocks.length - 1}
                        onClick={() => onChange(moved(blocks, index, 1), 'step')}
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
                      {context.onDuplicate === undefined ? null : (
                        <Button variant="ghost" onClick={() => context.onDuplicate?.(block.id)}>
                          {t('documents.pdfBuilder.blocks.duplicate')}
                        </Button>
                      )}
                      {context.onCopy === undefined ? null : (
                        <Button variant="ghost" onClick={() => context.onCopy?.(block.id)}>
                          {t('documents.pdfBuilder.blocks.copy')}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        onClick={() =>
                          onChange(
                            blocks.filter((candidate) => candidate.id !== block.id),
                            'step',
                          )
                        }
                      >
                        {t('documents.designer.block.remove')}
                      </Button>
                    </div>
                    {problem === undefined ? null : (
                      <p className="border-t border-danger bg-danger-subtle px-3 py-2 text-xs text-content">
                        {problem}
                      </p>
                    )}
                    {open === block.id ? (
                      <div className="border-t border-border-subtle px-3 py-3">
                        <BlockEditor
                          block={block}
                          context={context}
                          onChange={(next, kind = 'typing') =>
                            onChange(
                              blocks.map((candidate) =>
                                candidate.id === block.id ? next : candidate,
                              ),
                              kind,
                            )
                          }
                        />
                      </div>
                    ) : null}
                  </>
                )}
              </SortableBlock>
            );
          })}
        </div>
      </SortableContext>
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
            onChange([...blocks, newBlock(adding, id, context.form)], 'step');
            setOpen(id);
          }}
        >
          {t('documents.designer.block.add')}
        </Button>
      </div>
    </div>
  );
}

/** A block that can be dragged by its handle. */
function SortableBlock({
  id,
  problem,
  children,
}: {
  id: string;
  problem: boolean;
  children: (handle: ReactNode) => ReactNode;
}) {
  const { t } = useTranslation();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={t('documents.pdfBuilder.blocks.drag')}
      className="cursor-grab touch-none rounded px-1 text-content-muted hover:bg-surface-muted"
    >
      ⠿
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-attention={problem ? 'true' : undefined}
      className={[
        'rounded-md border bg-surface',
        problem ? 'border-danger' : 'border-border-subtle',
        isDragging ? 'opacity-40' : '',
      ].join(' ')}
    >
      {children(handle)}
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
    case 'information':
      return block.informationId;
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
  onChange: (block: AnyBlock, kind?: ChangeKind) => void;
  context: Context;
}) {
  return (
    <div className="flex flex-col gap-3">
      <BlockSettings block={block} onChange={onChange} context={context} />
      {WITH_APPEARANCE.has(block.type) ? (
        <Appearance block={block} onChange={(next) => onChange(next, 'step')} />
      ) : null}
    </div>
  );
}

/** A block's text colour and shading (1.3.0 decision 9). */
function Appearance({ block, onChange }: { block: AnyBlock; onChange: (block: AnyBlock) => void }) {
  const { t } = useTranslation();
  const colour = 'colour' in block ? block.colour : undefined;
  const shaded = 'shaded' in block ? block.shaded === true : false;
  return (
    <div className="grid grid-cols-1 items-end gap-3 border-t border-border-subtle pt-3 lg:grid-cols-2">
      <SelectInput
        label={t('documents.pdfBuilder.style.blockColour')}
        value={colour ?? 'default'}
        options={[
          { value: 'default', label: t('documents.pdfBuilder.style.colourDefault') },
          ...BLOCK_COLOURS.map((value) => ({
            value,
            label: t(`documents.pdfBuilder.style.colours.${value}`),
          })),
        ]}
        onChange={(value) =>
          onChange(withOptional(block, 'colour', value === 'default' ? undefined : value))
        }
      />
      <CheckInput
        label={t('documents.pdfBuilder.style.shaded')}
        checked={shaded}
        onChange={(on) => onChange(withOptional(block, 'shaded', on ? true : undefined))}
      />
    </div>
  );
}

function BlockSettings({
  block,
  onChange,
  context,
}: {
  block: AnyBlock;
  onChange: (block: AnyBlock, kind?: ChangeKind) => void;
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
    case 'information': {
      const blocks = informationBlocks(form);
      const language = locale.startsWith('ar') ? 'ar' : 'en';
      const name = (text: Record<string, string> | undefined) =>
        text?.[language] ?? text?.en ?? Object.values(text ?? {})[0] ?? '';
      return blocks.length === 0 ? (
        <p className="text-sm text-content-muted">{t('documents.designer.block.noInformation')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          <SelectInput
            label={t('documents.designer.block.information')}
            value={block.informationId}
            options={blocks.map((candidate) => ({
              value: candidate.id,
              label: (name(candidate.heading) || name(candidate.body)).slice(0, 80) || candidate.id,
            }))}
            onChange={(informationId) => onChange({ ...block, informationId })}
          />
          <p className="text-xs text-content-muted">
            {t('documents.designer.block.informationHint')}
          </p>
        </div>
      );
    }
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
                    onChange(
                      { ...block, columns: block.columns.filter((_c, at) => at !== index) },
                      'step',
                    )
                  }
                >
                  {t('documents.designer.block.removeItem')}
                </Button>
              </div>
              <BlockList
                container={columnContainer(block.id, index)}
                blocks={column.blocks}
                context={context}
                onChange={(blocks, kind) =>
                  onChange(
                    {
                      ...block,
                      columns: block.columns.map((candidate, at) =>
                        at === index ? { ...candidate, blocks: blocks as LeafBlock[] } : candidate,
                      ),
                    },
                    kind,
                  )
                }
              />
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              disabled={block.columns.length >= 3}
              onClick={() =>
                onChange(
                  { ...block, columns: [...block.columns, { width: 1, blocks: [] }] },
                  'step',
                )
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
