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
  useDraggable,
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
  addField,
  addPage,
  addSection,
  allIds,
  duplicate,
  type Field,
  type FieldType,
  type FormDefinition,
  generateId,
  type Section,
  isCalculated,
  isEditError,
  locate,
  moveField,
  movePage,
  moveSection,
  newField,
  newPage,
  newRepeatableSection,
  newSection,
  referencesTo,
  remove,
  subtreeIds,
} from '@integr8/form-engine';
import { type TFunction, useTranslation } from '@integr8/i18n';
import { useState, type ReactNode } from 'react';
import { Button } from '~/components/ui';
import { PALETTE } from '../model/catalog';
import type { EditorAction } from '../model/editor';
import { say } from '../model/text';
import { Dialog } from './dialog';

/**
 * The canvas and the palette: where a form is assembled.
 *
 * Everything that moves is draggable — questions within and between sections,
 * sections within and between pages, pages among themselves — and everything
 * draggable can also be moved with the keyboard and with explicit buttons,
 * because a builder that only works with a mouse is not one an admin on a
 * trackpad, or with a screen reader, can use.
 *
 * Every change goes through the engine's authoring operations; the canvas only
 * decides which one a gesture means.
 */

type DragKind = 'palette' | 'page' | 'section' | 'field';

const dragId = (kind: DragKind, id: string) => `${kind}:${id}`;
const dropId = (sectionId: string) => `drop:${sectionId}`;

function parse(id: string | number): { kind: DragKind | 'drop'; id: string } {
  const text = String(id);
  const colon = text.indexOf(':');
  return { kind: text.slice(0, colon) as DragKind | 'drop', id: text.slice(colon + 1) };
}

/** Only targets that make sense for what is being dragged: a page never lands inside a section. */
const collision: CollisionDetection = (args) => {
  const active = parse(args.active.id).kind;
  const accepts = (kind: string) =>
    active === 'palette' || active === 'field'
      ? kind === 'field' || kind === 'drop'
      : kind === active;
  const droppableContainers = args.droppableContainers.filter((container) =>
    accepts(parse(container.id).kind),
  );
  const within = pointerWithin({ ...args, droppableContainers });
  if (within.length > 0) {
    // Prefer the most specific target: a question over the section that holds it.
    return [...within].sort(
      (a, b) => Number(parse(b.id).kind === 'field') - Number(parse(a.id).kind === 'field'),
    );
  }
  return closestCenter({ ...args, droppableContainers });
};

interface BuilderCanvasProps {
  definition: FormDefinition;
  selected: string | undefined;
  locale: string;
  readOnly: boolean;
  dispatch: (action: EditorAction) => void;
}

export function BuilderWorkspace(
  props: BuilderCanvasProps & { panel: ReactNode; publishedIds: ReadonlySet<string> },
) {
  const { definition, locale, readOnly, dispatch, selected, panel, publishedIds } = props;
  const { t } = useTranslation();
  const [dragging, setDragging] = useState<string | undefined>(undefined);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const createField = (current: FormDefinition, type: FieldType) => {
    const label = t(`forms.fieldType.${type}`);
    return newField(
      type,
      generateId(label, 'field', [...allIds(current), ...publishedIds]),
      { [locale]: label },
      locale,
    );
  };

  /** Clicking a palette item: add after the selected question, or to the selected section, or at the end. */
  const addFromPalette = (type: FieldType) => {
    const field = createField(definition, type);
    const target = insertionPoint(definition, selected);
    dispatch({
      type: 'edit',
      apply: (current) => addField(current, target.section, field, target.index),
      select: field.id,
    });
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(undefined);
    if (event.over === null) {
      return;
    }
    const active = parse(event.active.id);
    const over = parse(event.over.id);
    if (active.id === over.id && active.kind === over.kind) {
      return;
    }

    const target = (current: FormDefinition) => {
      if (over.kind === 'drop') {
        const at = locate(current, over.id);
        const section =
          at === undefined ? undefined : current.pages[at.page]?.sections[at.section ?? -1];
        return { section: over.id, index: section?.fields.length ?? 0 };
      }
      const at = locate(current, over.id);
      const section = at === undefined ? undefined : current.pages[at.page]!.sections[at.section!]!;
      return { section: section?.id ?? '', index: at?.field ?? 0 };
    };

    switch (active.kind) {
      case 'palette': {
        const field = createField(definition, active.id as FieldType);
        dispatch({
          type: 'edit',
          apply: (current) => {
            const { section, index } = target(current);
            return addField(current, section, field, index);
          },
          select: field.id,
        });
        break;
      }
      case 'field':
        dispatch({
          type: 'edit',
          apply: (current) => {
            const { section, index } = target(current);
            return moveField(current, active.id, section, index);
          },
        });
        break;
      case 'section':
        dispatch({
          type: 'edit',
          apply: (current) => {
            const at = locate(current, over.id);
            if (at === undefined) {
              return { error: 'not_found', id: over.id };
            }
            return moveSection(current, active.id, current.pages[at.page]!.id, at.section ?? 0);
          },
        });
        break;
      case 'page':
        dispatch({
          type: 'edit',
          apply: (current) => {
            const index = current.pages.findIndex((page) => page.id === over.id);
            return movePage(current, active.id, index);
          },
        });
        break;
      default:
        break;
    }
  };

  const overlay =
    dragging === undefined ? undefined : describeDrag(definition, dragging, locale, t);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={(event: DragStartEvent) => setDragging(String(event.active.id))}
      onDragCancel={() => setDragging(undefined)}
      onDragEnd={onDragEnd}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)_22rem] overflow-hidden">
        <aside className="overflow-y-auto border-e border-border-subtle bg-surface p-4">
          {readOnly ? null : <Palette onAdd={addFromPalette} />}
        </aside>
        <main className="overflow-y-auto bg-background p-6">
          <Canvas {...props} />
        </main>
        <aside className="overflow-y-auto border-s border-border-subtle bg-surface">{panel}</aside>
      </div>
      <DragOverlay dropAnimation={null}>
        {overlay === undefined ? null : (
          <div className="rounded-md border border-accent bg-surface px-3 py-2 text-sm font-medium text-content shadow-lg">
            {overlay}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function describeDrag(
  definition: FormDefinition,
  id: string,
  locale: string,
  t: TFunction,
): string {
  const parsed = parse(id);
  if (parsed.kind === 'palette') {
    return t(`forms.fieldType.${parsed.id as FieldType}`);
  }
  return nameOf(definition, parsed.id, locale, t);
}

export function nameOf(
  definition: FormDefinition,
  id: string,
  locale: string,
  t: TFunction,
): string {
  const at = locate(definition, id);
  if (at === undefined) {
    return id;
  }
  const page = definition.pages[at.page]!;
  if (at.kind === 'page') {
    return say(page.title, locale) || t('forms.canvas.page', { number: at.page + 1 });
  }
  const section = page.sections[at.section!]!;
  if (at.kind === 'section') {
    return sectionLabel(section, locale, t);
  }
  const field = section.fields[at.field!]!;
  return say(field.label, locale) || field.id;
}

/**
 * A new repeatable section, ready to publish: repeating up to 20 times, and
 * starting with a short answer question, because a section with nothing to
 * repeat does not compile.
 */
export function repeatableSectionFor(
  definition: FormDefinition,
  locale: string,
  t: TFunction,
  publishedIds: ReadonlySet<string> = new Set(),
): Section {
  const ids = allIds(definition);
  const id = generateId('section', 'section', [...ids, ...publishedIds]);
  const question = t('forms.fieldType.text');
  const field = newField(
    'text',
    generateId(question, 'field', [...ids, ...publishedIds, id]),
    { [locale]: question },
    locale,
  );
  return newRepeatableSection(id, { [locale]: t('forms.canvas.defaultEntryLabel') }, field);
}

/** A section's title, or for an untitled repeatable section what one entry is called. */
function sectionLabel(section: Section, locale: string, t: TFunction): string {
  return (
    say(section.title, locale) ||
    say(section.repeat?.entryLabel, locale) ||
    t('forms.canvas.section')
  );
}

/** Where a clicked palette item goes. */
function insertionPoint(
  definition: FormDefinition,
  selected: string | undefined,
): { section: string; index: number | undefined } {
  const at = selected === undefined ? undefined : locate(definition, selected);
  if (at !== undefined) {
    const page = definition.pages[at.page]!;
    if (at.kind === 'field') {
      return { section: page.sections[at.section!]!.id, index: at.field! + 1 };
    }
    if (at.kind === 'section') {
      return { section: page.sections[at.section!]!.id, index: undefined };
    }
    return { section: page.sections.at(-1)!.id, index: undefined };
  }
  const lastPage = definition.pages.at(-1)!;
  return { section: lastPage.sections.at(-1)!.id, index: undefined };
}

function Palette({ onAdd }: { onAdd: (type: FieldType) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 text-start">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-content">{t('forms.palette.title')}</h2>
        <p className="text-xs text-content-muted">{t('forms.palette.hint')}</p>
      </div>
      {PALETTE.map((group) => (
        <section key={group.purpose} className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-content-muted">
            {t(`forms.palette.purpose.${group.purpose}`)}
          </h3>
          <ul className="flex flex-col gap-1">
            {group.types.map((description) => (
              <PaletteItem key={description.type} type={description.type} onAdd={onAdd} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PaletteItem({ type, onAdd }: { type: FieldType; onAdd: (type: FieldType) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId('palette', type),
  });
  return (
    <li>
      <button
        ref={setNodeRef}
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => onAdd(type)}
        className={[
          'w-full cursor-grab rounded-md border border-border-subtle bg-surface px-3 py-2 text-start text-sm text-content hover:bg-surface-muted',
          isDragging ? 'opacity-50' : '',
        ].join(' ')}
      >
        {t(`forms.fieldType.${type}`)}
      </button>
    </li>
  );
}

function Canvas({
  definition,
  selected,
  locale,
  readOnly,
  dispatch,
  publishedIds = new Set<string>(),
}: BuilderCanvasProps & { publishedIds?: ReadonlySet<string> }) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState<string | undefined>(undefined);

  const actions: ItemActions = {
    readOnly,
    select: (id) => dispatch({ type: 'select', id }),
    duplicate: (id) => {
      const result = duplicate(definition, id);
      if (isEditError(result)) {
        dispatch({ type: 'edit', apply: () => result });
        return;
      }
      dispatch({
        type: 'edit',
        apply: (current) => {
          const again = duplicate(current, id);
          return isEditError(again) ? again : again.definition;
        },
        select: result.copyId,
      });
    },
    move: (id, delta) => dispatch({ type: 'edit', apply: (current) => nudge(current, id, delta) }),
    remove: (id) => {
      const at = locate(definition, id);
      const referenced = referencesTo(definition, subtreeIds(definition, id)).length > 0;
      if (at?.kind === 'field' && !referenced) {
        dispatch({ type: 'edit', apply: (current) => remove(current, id) });
      } else {
        setRemoving(id);
      }
    },
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 text-start">
      <SortableContext
        items={definition.pages.map((page) => dragId('page', page.id))}
        strategy={verticalListSortingStrategy}
      >
        {definition.pages.map((page, pageIndex) => (
          <Sortable
            key={page.id}
            id={dragId('page', page.id)}
            disabled={readOnly}
            className={[
              'flex flex-col gap-4 rounded-xl border-2 bg-surface-muted p-4',
              selected === page.id ? 'border-accent' : 'border-transparent',
            ].join(' ')}
            handleLabel={t('forms.canvas.drag', {
              name: say(page.title, locale) || t('forms.canvas.page', { number: pageIndex + 1 }),
            })}
            header={
              <ItemHeader
                name={say(page.title, locale) || t('forms.canvas.page', { number: pageIndex + 1 })}
                id={page.id}
                actions={actions}
                canMoveUp={pageIndex > 0}
                canMoveDown={pageIndex < definition.pages.length - 1}
                heading="page"
                badges={page.visibleWhen === undefined ? [] : [t('forms.canvas.conditional')]}
              />
            }
          >
            <>
              <SortableContext
                items={page.sections.map((section) => dragId('section', section.id))}
                strategy={verticalListSortingStrategy}
              >
                {page.sections.map((section, sectionIndex) => (
                  <Sortable
                    key={section.id}
                    id={dragId('section', section.id)}
                    disabled={readOnly}
                    className={[
                      'flex flex-col gap-3 rounded-lg border-2 bg-surface p-3',
                      selected === section.id ? 'border-accent' : 'border-border-subtle',
                    ].join(' ')}
                    handleLabel={t('forms.canvas.drag', {
                      name: sectionLabel(section, locale, t),
                    })}
                    header={
                      <ItemHeader
                        name={sectionLabel(section, locale, t)}
                        id={section.id}
                        actions={actions}
                        canMoveUp={sectionIndex > 0 || pageIndex > 0}
                        canMoveDown={
                          sectionIndex < page.sections.length - 1 ||
                          pageIndex < definition.pages.length - 1
                        }
                        heading="section"
                        badges={[
                          ...(section.repeat === undefined
                            ? []
                            : [
                                t('forms.canvas.repeats', {
                                  maximum: section.repeat.maxEntries,
                                }),
                              ]),
                          ...(section.visibleWhen === undefined
                            ? []
                            : [t('forms.canvas.conditional')]),
                        ]}
                      />
                    }
                  >
                    <SectionBody sectionId={section.id} empty={section.fields.length === 0}>
                      <SortableContext
                        items={section.fields.map((field) => dragId('field', field.id))}
                        strategy={verticalListSortingStrategy}
                      >
                        {section.fields.map((field, fieldIndex) => (
                          <FieldRow
                            key={field.id}
                            field={field}
                            locale={locale}
                            selected={selected === field.id}
                            actions={actions}
                            first={fieldIndex === 0}
                            last={fieldIndex === section.fields.length - 1}
                          />
                        ))}
                      </SortableContext>
                    </SectionBody>
                  </Sortable>
                ))}
              </SortableContext>
              {readOnly ? null : (
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const id = generateId('section', 'section', allIds(definition));
                      dispatch({
                        type: 'edit',
                        apply: (current) => addSection(current, page.id, newSection(id)),
                        select: id,
                      });
                    }}
                  >
                    {`+ ${t('forms.canvas.addSection')}`}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const section = repeatableSectionFor(definition, locale, t, publishedIds);
                      dispatch({
                        type: 'edit',
                        apply: (current) => addSection(current, page.id, section),
                        select: section.id,
                      });
                    }}
                  >
                    {`+ ${t('forms.canvas.addRepeatableSection')}`}
                  </Button>
                </div>
              )}
            </>
          </Sortable>
        ))}
      </SortableContext>

      {readOnly ? null : (
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              const ids = allIds(definition);
              const pageId = generateId('page', 'page', ids);
              const sectionId = generateId('section', 'section', [...ids, pageId]);
              dispatch({
                type: 'edit',
                apply: (current) => addPage(current, newPage(pageId, [newSection(sectionId)])),
                select: pageId,
              });
            }}
          >
            {`+ ${t('forms.canvas.addPage')}`}
          </Button>
        </div>
      )}

      <RemoveDialog
        definition={definition}
        id={removing}
        locale={locale}
        onCancel={() => setRemoving(undefined)}
        onConfirm={(id) => {
          setRemoving(undefined);
          dispatch({ type: 'edit', apply: (current) => remove(current, id) });
        }}
      />
    </div>
  );
}

/**
 * One step up or down, for the buttons and for anybody not dragging. A section
 * at the edge of its page steps into the neighbouring page.
 */
export function nudge(definition: FormDefinition, id: string, delta: -1 | 1) {
  const at = locate(definition, id);
  if (at === undefined) {
    return { error: 'not_found' as const, id };
  }
  if (at.kind === 'page') {
    return movePage(definition, id, at.page + delta);
  }
  const page = definition.pages[at.page]!;
  if (at.kind === 'section') {
    const index = at.section! + delta;
    if (index >= 0 && index < page.sections.length) {
      return moveSection(definition, id, page.id, index);
    }
    const neighbour = definition.pages[at.page + delta];
    return neighbour === undefined
      ? { error: 'invalid_target' as const, id }
      : moveSection(definition, id, neighbour.id, delta < 0 ? neighbour.sections.length : 0);
  }
  const section = page.sections[at.section!]!;
  return moveField(definition, id, section.id, at.field! + delta);
}

interface ItemActions {
  readOnly: boolean;
  select: (id: string) => void;
  duplicate: (id: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  remove: (id: string) => void;
}

/**
 * Something that can be dragged by its handle: a header row that starts with
 * the handle, and whatever the item contains beneath it.
 */
function Sortable({
  id,
  disabled,
  className,
  handleLabel,
  header,
  children,
}: {
  id: string;
  disabled: boolean;
  className: string;
  handleLabel: string;
  header: ReactNode;
  children?: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`${className} ${isDragging ? 'opacity-40' : ''}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {disabled ? null : (
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            aria-label={handleLabel}
            className="cursor-grab touch-none rounded px-1 text-content-muted hover:bg-surface-muted"
          >
            ⠿
          </button>
        )}
        {header}
      </div>
      {children}
    </div>
  );
}

function SectionBody({
  sectionId,
  empty,
  children,
}: {
  sectionId: string;
  empty: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: dropId(sectionId) });
  return (
    <div
      ref={setNodeRef}
      className={[
        'flex min-h-14 flex-col gap-2 rounded-md p-1',
        isOver ? 'bg-accent/10 outline-2 outline-dashed outline-accent' : '',
      ].join(' ')}
    >
      {children}
      {empty ? (
        <p className="rounded-md border border-dashed border-border-subtle px-3 py-4 text-center text-sm text-content-muted">
          {t('forms.canvas.emptySection')}
        </p>
      ) : null}
    </div>
  );
}

function ItemHeader({
  name,
  id,
  actions,
  canMoveUp,
  canMoveDown,
  heading,
  badges,
}: {
  name: string;
  id: string;
  actions: ItemActions;
  canMoveUp: boolean;
  canMoveDown: boolean;
  heading: 'page' | 'section';
  badges: string[];
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => actions.select(id)}
        className={[
          'min-w-0 flex-1 truncate text-start text-content hover:underline',
          heading === 'page' ? 'text-base font-semibold' : 'text-sm font-semibold',
        ].join(' ')}
      >
        {name}
      </button>
      {badges.map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
      <RowActions
        id={id}
        name={name}
        actions={actions}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
      />
    </>
  );
}

function FieldRow({
  field,
  locale,
  selected,
  actions,
  first,
  last,
}: {
  field: Field;
  locale: string;
  selected: boolean;
  actions: ItemActions;
  first: boolean;
  last: boolean;
}) {
  const { t } = useTranslation();
  const name = say(field.label, locale) || field.id;
  const badges = [
    ...(field.required === true ? [t('forms.canvas.required')] : []),
    ...(field.visibleWhen === undefined ? [] : [t('forms.canvas.conditional')]),
    ...(isCalculated(field) ? [t('forms.canvas.calculated')] : []),
    ...((field.rules?.length ?? 0) > 0
      ? [t('forms.canvas.checks', { count: field.rules?.length ?? 0 })]
      : []),
  ];

  return (
    <Sortable
      id={dragId('field', field.id)}
      disabled={actions.readOnly}
      className={[
        'flex items-center gap-2 rounded-md border-2 bg-surface px-2 py-2',
        selected ? 'border-accent' : 'border-border-subtle',
      ].join(' ')}
      handleLabel={t('forms.canvas.drag', { name })}
      header={
        <>
          <button
            type="button"
            onClick={() => actions.select(field.id)}
            aria-pressed={selected}
            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start"
          >
            <span className="w-full truncate text-sm font-medium text-content">{name}</span>
            <span className="text-xs text-content-muted">{t(`forms.fieldType.${field.type}`)}</span>
          </button>
          <div className="flex flex-wrap justify-end gap-1">
            {badges.map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
          </div>
          <RowActions
            id={field.id}
            name={name}
            actions={actions}
            canMoveUp={!first}
            canMoveDown={!last}
          />
        </>
      }
    />
  );
}

function RowActions({
  id,
  name,
  actions,
  canMoveUp,
  canMoveDown,
}: {
  id: string;
  name: string;
  actions: ItemActions;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const { t } = useTranslation();
  if (actions.readOnly) {
    return null;
  }
  const small = 'px-2 py-1';
  return (
    <div
      role="group"
      aria-label={t('forms.canvas.actions', { name })}
      className="flex shrink-0 gap-0.5"
    >
      <Button
        variant="ghost"
        className={small}
        aria-label={t('forms.canvas.moveUp')}
        title={t('forms.canvas.moveUp')}
        disabled={!canMoveUp}
        onClick={() => actions.move(id, -1)}
      >
        ↑
      </Button>
      <Button
        variant="ghost"
        className={small}
        aria-label={t('forms.canvas.moveDown')}
        title={t('forms.canvas.moveDown')}
        disabled={!canMoveDown}
        onClick={() => actions.move(id, 1)}
      >
        ↓
      </Button>
      <Button
        variant="ghost"
        className={small}
        aria-label={t('forms.canvas.duplicate')}
        title={t('forms.canvas.duplicate')}
        onClick={() => actions.duplicate(id)}
      >
        ⧉
      </Button>
      <Button
        variant="ghost"
        className={small}
        aria-label={t('forms.canvas.delete')}
        title={t('forms.canvas.delete')}
        onClick={() => actions.remove(id)}
      >
        🗑
      </Button>
    </div>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-xs text-content-muted">
      {children}
    </span>
  );
}

function RemoveDialog({
  definition,
  id,
  locale,
  onCancel,
  onConfirm,
}: {
  definition: FormDefinition;
  id: string | undefined;
  locale: string;
  onCancel: () => void;
  onConfirm: (id: string) => void;
}) {
  const { t } = useTranslation();
  const references = id === undefined ? [] : referencesTo(definition, subtreeIds(definition, id));
  const removed = new Set(id === undefined ? [] : subtreeIds(definition, id));
  // A rule inside what is being deleted goes with it; only rules left behind need fixing.
  const outside = references.filter((reference) => !removed.has(reference.from));

  return (
    <Dialog
      open={id !== undefined}
      title={t('forms.remove.title', {
        name: id === undefined ? '' : nameOf(definition, id, locale, t),
      })}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={() => id !== undefined && onConfirm(id)}>
            {t('forms.remove.confirm')}
          </Button>
        </>
      }
    >
      <p>{t('forms.remove.kept')}</p>
      {outside.length === 0 ? null : (
        <>
          <p className="font-medium">{t('forms.remove.references')}</p>
          <ul className="list-disc ps-5">
            {outside.map((reference) => (
              <li
                key={`${reference.from}-${reference.where}-${reference.rule ?? ''}-${reference.to}`}
              >
                {t(`forms.remove.${reference.where}`, {
                  from: nameOf(definition, reference.from, locale, t),
                })}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
