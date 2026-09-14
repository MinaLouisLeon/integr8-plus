import {
  type ArithmeticOperator,
  type ConditionModel,
  describeFieldType,
  type Expression,
  type Field,
  fieldsOf,
  findField,
  type FormDefinition,
  fromExpression,
  generateId,
  locate,
  referencedFields,
  type LocalizedText,
  type Rule,
  updateField,
  updatePage,
  updateSection,
} from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '~/components/ui';
import { type Calculation, fromCalculation, type Term, toCalculation } from '../model/calculation';
import { editorFor, type PropertyEditor, specificProperties } from '../model/catalog';
import type { EditorAction } from '../model/editor';
import { keyFromWording } from '../model/rename';
import { say, withText } from '../model/text';
import {
  completeExpression,
  ConditionBuilder,
  lookupIn,
  newClause,
  VisibilityEditor,
} from './condition-builder';

/**
 * The panel beside the canvas: everything about the selected question, section
 * or page.
 *
 * For a question, the "Answer" group is not a hand-written form per type. It
 * lists the properties the engine's registry declares for that type and gives
 * each the editor its kind of value needs, so the panel and the engine cannot
 * disagree about what a field has.
 */

interface PanelProps {
  definition: FormDefinition;
  selected: string | undefined;
  /** Changes when a different element is selected; see `EditorState.selection`. */
  selection: number;
  /** Every id any published version has used, whose answer keys are fixed for good. */
  publishedIds: ReadonlySet<string>;
  locale: string;
  dispatch: (action: EditorAction) => void;
  readOnly: boolean;
}

export function ConfigPanel({
  definition,
  selected,
  selection,
  publishedIds,
  locale,
  dispatch,
  readOnly,
}: PanelProps) {
  const { t } = useTranslation();
  const at = selected === undefined ? undefined : locate(definition, selected);

  if (selected === undefined || at === undefined) {
    return <p className="p-4 text-sm text-content-muted">{t('forms.config.empty')}</p>;
  }

  if (at.kind === 'field') {
    const field = definition.pages[at.page]!.sections[at.section!]!.fields[at.field!]!;
    return (
      <FieldPanel
        key={selection}
        definition={definition}
        field={field}
        locale={locale}
        readOnly={readOnly}
        onChange={(update) =>
          dispatch({ type: 'edit', apply: (current) => updateField(current, field.id, update) })
        }
        onWordingSettled={() => {
          const renamed = keyFromWording(definition, field.id, locale, publishedIds);
          if (renamed !== undefined) {
            dispatch({
              type: 'edit',
              apply: () => renamed.definition,
              select: renamed.id,
              renamed: true,
            });
          }
        }}
      />
    );
  }

  const page = definition.pages[at.page]!;
  const container = at.kind === 'section' ? page.sections[at.section!]! : page;
  const apply = (
    update: (element: {
      title?: LocalizedText | undefined;
      visibleWhen?: Expression | undefined;
    }) => object,
  ) =>
    dispatch({
      type: 'edit',
      apply: (current) =>
        at.kind === 'section'
          ? updateSection(current, container.id, (section) =>
              compact({ ...section, ...update(section) }),
            )
          : updatePage(current, container.id, (element) =>
              compact({ ...element, ...update(element) }),
            ),
    });

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-6 p-4">
      <h2 className="text-base font-semibold text-content">
        {at.kind === 'section' ? t('forms.config.section') : t('forms.config.page')}
      </h2>
      <Group title={t('forms.config.groups.basics')}>
        <TextInput
          label={t('forms.config.title')}
          value={say(container.title, locale)}
          onChange={(value) =>
            apply((element) => optional('title', withText(element.title, locale, value)))
          }
        />
      </Group>
      <Group title={t('forms.config.groups.visibility')}>
        <VisibilityEditor
          key={container.id}
          definition={definition}
          elementId={container.id}
          expression={container.visibleWhen}
          locale={locale}
          onChange={(expression) => apply(() => optional('visibleWhen', expression))}
        />
      </Group>
    </fieldset>
  );
}

/** `{ [key]: value }`, or `{ [key]: undefined }` to be stripped — so a cleared property is removed, not stored empty. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V | undefined> {
  return { [key]: value } as Record<K, V | undefined>;
}

/** Removes keys whose value is `undefined`, which the strict definition schema would otherwise refuse. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function FieldPanel({
  definition,
  field,
  locale,
  readOnly,
  onChange,
  onWordingSettled,
}: {
  definition: FormDefinition;
  field: Field;
  locale: string;
  readOnly: boolean;
  onChange: (update: (field: Field) => Field) => void;
  onWordingSettled: () => void;
}) {
  const { t } = useTranslation();
  const set = (patch: Record<string, unknown>) =>
    onChange((current) => compact({ ...current, ...patch }));
  const record = field as unknown as Record<string, unknown>;
  const calculated = 'calculation' in field && field.calculation !== undefined;

  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-6 p-4">
      <h2 className="text-base font-semibold text-content">{t('forms.config.field')}</h2>

      <Group title={t('forms.config.groups.basics')}>
        <TextInput
          label={t('forms.config.label')}
          value={say(field.label, locale)}
          onChange={(value) => set({ label: withText(field.label, locale, value) ?? {} })}
          onBlur={onWordingSettled}
        />
        <TextInput
          label={t('forms.config.help')}
          placeholder={t('forms.config.helpPlaceholder')}
          value={say(field.help, locale)}
          multiline
          onChange={(value) => set({ help: withText(field.help, locale, value) })}
        />
        <ReadOnlyValue label={t('forms.config.type')} value={t(`forms.fieldType.${field.type}`)} />
        <ReadOnlyValue
          label={t('forms.config.key')}
          value={field.id}
          hint={t('forms.config.keyHelp')}
          mono
        />
        {calculated ? null : (
          <Toggle
            label={t('forms.config.required')}
            checked={field.required === true}
            onChange={(checked) => set({ required: checked ? true : undefined })}
          />
        )}
        <Toggle
          label={t('forms.config.readOnly')}
          checked={field.readOnly === true}
          onChange={(checked) => set({ readOnly: checked ? true : undefined })}
        />
      </Group>

      {specificProperties(field.type).length === 0 ? null : (
        <Group title={t('forms.config.groups.answer')}>
          {specificProperties(field.type).map((property) => {
            const editor = editorFor(field.type, property);
            if (editor === undefined || (calculated && property === 'default')) {
              return null;
            }
            return (
              <PropertyInput
                key={property}
                definition={definition}
                field={field}
                property={property}
                editor={editor}
                value={record[property]}
                locale={locale}
                onChange={(value) =>
                  set(
                    property === 'calculation' && value !== undefined
                      ? { calculation: value, required: undefined, default: undefined }
                      : { [property]: value },
                  )
                }
              />
            );
          })}
        </Group>
      )}

      <Group title={t('forms.config.groups.visibility')}>
        <VisibilityEditor
          definition={definition}
          elementId={field.id}
          expression={field.visibleWhen}
          locale={locale}
          onChange={(expression) => set({ visibleWhen: expression })}
        />
      </Group>

      <Group title={t('forms.config.groups.checks')}>
        <ChecksEditor
          definition={definition}
          field={field}
          locale={locale}
          onChange={(rules) => set({ rules: rules.length === 0 ? undefined : rules })}
        />
      </Group>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Property editors
// ---------------------------------------------------------------------------

function PropertyInput({
  definition,
  field,
  property,
  editor,
  value,
  locale,
  onChange,
}: {
  definition: FormDefinition;
  field: Field;
  property: string;
  editor: PropertyEditor;
  value: unknown;
  locale: string;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  // Every property name the registry declares has a label; the catalog test holds that.
  const label = t(`forms.config.property.${property as 'min'}`);

  switch (editor) {
    case 'integer':
      return (
        <TextInput
          label={label}
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(text) => {
            const parsed = Number.parseInt(text, 10);
            onChange(text === '' || Number.isNaN(parsed) ? undefined : parsed);
          }}
        />
      );
    case 'decimal':
    case 'text':
      return (
        <TextInput
          label={label}
          inputMode={editor === 'decimal' ? 'decimal' : undefined}
          // The registry's limits for text properties: a unit is at most 20 characters, a decimal 64.
          maxLength={property === 'unit' ? 20 : 64}
          value={typeof value === 'string' ? value : ''}
          onChange={(text) => onChange(text.trim() === '' ? undefined : text)}
        />
      );
    case 'boolean':
      return (
        <Toggle
          label={label}
          checked={value === true}
          onChange={(checked) => onChange(checked ? true : undefined)}
        />
      );
    case 'date':
    case 'time':
      return (
        <TextInput
          label={label}
          type={editor}
          value={typeof value === 'string' ? value : ''}
          onChange={(text) => onChange(text === '' ? undefined : text)}
        />
      );
    case 'datetime':
      return (
        <TextInput
          label={label}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(text) => onChange(text === '' ? undefined : `${text}:00${localOffset(text)}`)}
        />
      );
    case 'choice':
    case 'yes_no': {
      const options =
        editor === 'yes_no'
          ? [
              { value: 'yes', label: t('forms.config.yes') },
              { value: 'no', label: t('forms.config.no') },
              { value: 'not_applicable', label: t('forms.config.notApplicable') },
            ]
          : 'options' in field
            ? field.options.map((option) => ({
                value: option.value,
                label: say(option.label, locale),
              }))
            : [];
      return (
        <SelectInput
          label={label}
          value={typeof value === 'string' ? value : ''}
          options={[{ value: '', label: t('forms.config.notSet') }, ...options]}
          onChange={(next) => onChange(next === '' ? undefined : next)}
        />
      );
    }
    case 'choices': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-content">{label}</span>
          {'options' in field
            ? field.options.map((option) => (
                <Toggle
                  key={option.value}
                  label={say(option.label, locale)}
                  checked={selected.includes(option.value)}
                  onChange={(checked) => {
                    const next = checked
                      ? [...selected, option.value]
                      : selected.filter((candidate) => candidate !== option.value);
                    onChange(next.length === 0 ? undefined : next);
                  }}
                />
              ))
            : null}
        </div>
      );
    }
    case 'options':
      return (
        <OptionsEditor
          label={label}
          options={(value as { value: string; label: LocalizedText }[] | undefined) ?? []}
          locale={locale}
          onChange={onChange}
        />
      );
    case 'pattern':
      return (
        <PatternEditor
          label={label}
          value={value as PatternValue | undefined}
          locale={locale}
          onChange={onChange}
        />
      );
    case 'calculation':
      return (
        <CalculationEditor
          definition={definition}
          field={field}
          expression={value as Expression | undefined}
          locale={locale}
          onChange={onChange}
        />
      );
    case 'megabytes':
      return (
        <TextInput
          label={label}
          inputMode="decimal"
          value={
            typeof value === 'number' ? String(Math.round((value / 1_048_576) * 100) / 100) : ''
          }
          onChange={(text) => {
            const megabytes = Number.parseFloat(text);
            onChange(
              text === '' || Number.isNaN(megabytes) || megabytes <= 0
                ? undefined
                : Math.round(megabytes * 1_048_576),
            );
          }}
        />
      );
    case 'media_types':
      return (
        <TextInput
          label={label}
          hint={t('forms.config.acceptedTypesHint')}
          value={Array.isArray(value) ? (value as string[]).join(', ') : ''}
          onChange={(text) => {
            const types = text
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry !== '');
            onChange(types.length === 0 ? undefined : types);
          }}
        />
      );
  }
}

function localOffset(local: string): string {
  const offset = -new Date(local).getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
}

/**
 * Options, as the labels a person reads.
 *
 * The stored value is assigned once, when the option is added, and shown but
 * never edited: relabelling "Pass" to "Passed" must not orphan every answer
 * that already chose it.
 */
function OptionsEditor({
  label,
  options,
  locale,
  onChange,
}: {
  label: string;
  options: { value: string; label: LocalizedText }[];
  locale: string;
  onChange: (options: { value: string; label: LocalizedText }[]) => void;
}) {
  const { t } = useTranslation();

  const move = (from: number, to: number) => {
    const next = [...options];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-content">{label}</span>
      <ol className="flex flex-col gap-2">
        {options.map((option, index) => (
          <li key={option.value} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <input
                aria-label={t('forms.config.options.label', { number: index + 1 })}
                value={say(option.label, locale)}
                onChange={(event) =>
                  onChange(
                    options.map((current, at) =>
                      at === index
                        ? {
                            ...current,
                            label: withText(current.label, locale, event.target.value) ?? {},
                          }
                        : current,
                    ),
                  )
                }
                className="min-w-0 flex-1 rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
              />
              <Button
                variant="ghost"
                aria-label={t('forms.canvas.moveUp')}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
              >
                ↑
              </Button>
              <Button
                variant="ghost"
                aria-label={t('forms.canvas.moveDown')}
                disabled={index === options.length - 1}
                onClick={() => move(index, index + 1)}
              >
                ↓
              </Button>
              <Button
                variant="ghost"
                aria-label={t('forms.config.options.remove', { number: index + 1 })}
                disabled={options.length === 1}
                onClick={() => onChange(options.filter((_, at) => at !== index))}
              >
                ✕
              </Button>
            </div>
            <span className="font-mono text-xs text-content-muted">
              {t('forms.config.options.storedAs', { value: option.value })}
            </span>
          </li>
        ))}
      </ol>
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            const taken = new Set(options.map((option) => option.value));
            let number = options.length + 1;
            while (taken.has(`option_${String(number)}`)) {
              number += 1;
            }
            onChange([
              ...options,
              {
                value: `option_${String(number)}`,
                label: { [locale]: t('forms.config.options.label', { number }) },
              },
            ]);
          }}
        >
          {t('forms.config.options.add')}
        </Button>
      </div>
    </div>
  );
}

interface PatternValue {
  source: string;
  caseInsensitive?: boolean | undefined;
  message?: LocalizedText | undefined;
}

function PatternEditor({
  label,
  value,
  locale,
  onChange,
}: {
  label: string;
  value: PatternValue | undefined;
  locale: string;
  onChange: (value: PatternValue | undefined) => void;
}) {
  const { t } = useTranslation();
  const update = (patch: Partial<PatternValue>) => {
    const next = compact({ source: value?.source ?? '', ...value, ...patch });
    onChange(next.source === '' ? undefined : next);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-content">{label}</span>
      <TextInput
        label={t('forms.config.pattern.source')}
        hint={t('forms.config.pattern.hint')}
        mono
        value={value?.source ?? ''}
        onChange={(source) => update({ source })}
      />
      {value === undefined ? null : (
        <>
          <Toggle
            label={t('forms.config.pattern.caseInsensitive')}
            checked={value.caseInsensitive === true}
            onChange={(checked) => update({ caseInsensitive: checked ? true : undefined })}
          />
          <TextInput
            label={t('forms.config.pattern.message')}
            value={say(value.message, locale)}
            onChange={(text) => update({ message: withText(value.message, locale, text) })}
          />
        </>
      )}
    </div>
  );
}

const OPERATORS: readonly ArithmeticOperator[] = ['add', 'subtract', 'multiply', 'divide'];

function CalculationEditor({
  definition,
  field,
  expression,
  locale,
  onChange,
}: {
  definition: FormDefinition;
  field: Field;
  expression: Expression | undefined;
  locale: string;
  onChange: (expression: Expression | undefined) => void;
}) {
  const { t } = useTranslation();
  const [chain, setChain] = useState<Calculation | undefined>(() => toCalculation(expression));
  const numeric = fieldsOf(definition).filter(
    (candidate) =>
      candidate.id !== field.id && describeFieldType(candidate.type).valueType === 'number',
  );

  if (expression !== undefined && chain === undefined) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-content-muted">
          {referencedFields(expression).some((id) => findField(definition, id) === undefined)
            ? t('forms.calculation.broken')
            : t('forms.calculation.advanced')}
        </p>
        <Button variant="secondary" onClick={() => onChange(undefined)}>
          {t('forms.calculation.stop')}
        </Button>
      </div>
    );
  }

  if (chain === undefined) {
    return (
      <div>
        <Button
          variant="secondary"
          onClick={() => {
            const first: Term =
              numeric[0] === undefined
                ? { kind: 'number', value: '0' }
                : { kind: 'field', field: numeric[0].id };
            const next = { first, rest: [] };
            setChain(next);
            onChange(fromCalculation(next));
          }}
        >
          {t('forms.calculation.start')}
        </Button>
      </div>
    );
  }

  const commit = (next: Calculation) => {
    setChain(next);
    const terms = [next.first, ...next.rest.map((step) => step.term)];
    if (terms.every((term) => term.kind === 'field' || /^-?[0-9]+(\.[0-9]+)?$/u.test(term.value))) {
      onChange(fromCalculation(next));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-content">
        {t('forms.config.property.calculation')}
      </span>
      <TermInput
        term={chain.first}
        numeric={numeric}
        locale={locale}
        onChange={(first) => commit({ ...chain, first })}
      />
      {chain.rest.map((step, index) => (
        <div key={index} className="flex flex-wrap items-center gap-1">
          <select
            aria-label={t('forms.calculation.addStep')}
            value={step.operator}
            onChange={(event) =>
              commit({
                ...chain,
                rest: chain.rest.map((current, at) =>
                  at === index
                    ? { ...current, operator: event.target.value as ArithmeticOperator }
                    : current,
                ),
              })
            }
            className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
          >
            {OPERATORS.map((operator) => (
              <option key={operator} value={operator}>
                {t(`forms.calculation.operator.${operator}`)}
              </option>
            ))}
          </select>
          <TermInput
            term={step.term}
            numeric={numeric}
            locale={locale}
            onChange={(term) =>
              commit({
                ...chain,
                rest: chain.rest.map((current, at) =>
                  at === index ? { ...current, term } : current,
                ),
              })
            }
          />
          <Button
            variant="ghost"
            aria-label={t('forms.calculation.removeStep')}
            onClick={() => commit({ ...chain, rest: chain.rest.filter((_, at) => at !== index) })}
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            commit({
              ...chain,
              rest: [
                ...chain.rest,
                {
                  operator: 'add',
                  term:
                    numeric[0] === undefined
                      ? { kind: 'number', value: '0' }
                      : { kind: 'field', field: numeric[0].id },
                },
              ],
            })
          }
        >
          {t('forms.calculation.addStep')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setChain(undefined);
            onChange(undefined);
          }}
        >
          {t('forms.calculation.stop')}
        </Button>
      </div>
    </div>
  );
}

function TermInput({
  term,
  numeric,
  locale,
  onChange,
}: {
  term: Term;
  numeric: readonly Field[];
  locale: string;
  onChange: (term: Term) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <select
        aria-label={t('forms.calculation.term')}
        value={term.kind === 'field' ? term.field : ''}
        onChange={(event) =>
          onChange(
            event.target.value === ''
              ? { kind: 'number', value: '0' }
              : { kind: 'field', field: event.target.value },
          )
        }
        className="max-w-[12rem] rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
      >
        {numeric.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {say(candidate.label, locale) || candidate.id}
          </option>
        ))}
        <option value="">{t('forms.calculation.number')}</option>
      </select>
      {term.kind === 'number' ? (
        <input
          aria-label={t('forms.calculation.numberValue')}
          inputMode="decimal"
          value={term.value}
          onChange={(event) => onChange({ kind: 'number', value: event.target.value.trim() })}
          className="w-24 rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checks — custom validation rules with the admin's own message
// ---------------------------------------------------------------------------

interface CheckDraft {
  id: string;
  message: LocalizedText | undefined;
  /** `undefined` when the rule was written elsewhere and cannot be shown as clauses. */
  model: ConditionModel | undefined;
  original: Rule | undefined;
}

function ChecksEditor({
  definition,
  field,
  locale,
  onChange,
}: {
  definition: FormDefinition;
  field: Field;
  locale: string;
  onChange: (rules: Rule[]) => void;
}) {
  const { t } = useTranslation();
  const lookup = lookupIn(definition);
  const [drafts, setDrafts] = useState<CheckDraft[]>(() =>
    (field.rules ?? []).map((rule) => ({
      id: rule.id,
      message: rule.message,
      model: fromExpression(rule.assert, lookup),
      original: rule,
    })),
  );
  // The field itself first, as "This answer", then everything else in form order.
  const candidates = [
    field,
    ...fieldsOf(definition).filter((candidate) => candidate.id !== field.id),
  ];

  const commit = (next: CheckDraft[]) => {
    setDrafts(next);
    onChange(
      next.flatMap((draft): Rule[] => {
        if (draft.model === undefined) {
          return draft.original === undefined ? [] : [draft.original];
        }
        const assert = completeExpression(draft.model, lookup);
        return assert === undefined || draft.message === undefined
          ? []
          : [{ id: draft.id, assert, message: draft.message }];
      }),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {drafts.length === 0 ? (
        <p className="text-sm text-content-muted">{t('forms.checks.empty')}</p>
      ) : null}
      {drafts.map((draft, index) => (
        <div
          key={draft.id}
          className="flex flex-col gap-3 rounded-md border border-border-subtle p-3"
        >
          {draft.model === undefined ? (
            <p className="text-sm text-content-muted">{t('forms.conditions.advanced')}</p>
          ) : (
            <ConditionBuilder
              model={draft.model}
              candidates={candidates}
              lookup={lookup}
              locale={locale}
              selfId={field.id}
              lead={t('forms.checks.acceptedWhen')}
              onChange={(model) =>
                commit(
                  drafts.map((current, at) => (at === index ? { ...current, model } : current)),
                )
              }
            />
          )}
          <TextInput
            label={t('forms.checks.message')}
            placeholder={t('forms.checks.messagePlaceholder')}
            value={say(draft.message, locale)}
            error={draft.message === undefined ? t('forms.checks.messageRequired') : undefined}
            onChange={(text) =>
              commit(
                drafts.map((current, at) =>
                  at === index
                    ? { ...current, message: withText(current.message, locale, text) }
                    : current,
                ),
              )
            }
          />
          <div>
            <Button variant="ghost" onClick={() => commit(drafts.filter((_, at) => at !== index))}>
              {t('forms.checks.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            commit([
              ...drafts,
              {
                id: generateId(
                  'check',
                  'field',
                  drafts.map((draft) => draft.id),
                ),
                message: undefined,
                model: { match: 'all', clauses: [newClause(field)] },
                original: undefined,
              },
            ])
          }
        >
          {t('forms.checks.add')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small inputs
// ---------------------------------------------------------------------------

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-content-muted">{title}</h3>
      {children}
    </section>
  );
}

function TextInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  error,
  multiline = false,
  mono = false,
  inputMode,
  maxLength,
  onBlur,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: (() => void) | undefined;
  type?: string;
  placeholder?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  multiline?: boolean;
  mono?: boolean;
  inputMode?: 'decimal' | undefined;
  maxLength?: number | undefined;
}) {
  const id = useId();
  const className = [
    'w-full rounded-md border bg-surface px-2 py-1.5 text-start text-sm text-content',
    error === undefined ? 'border-border-subtle' : 'border-danger',
    mono ? 'font-mono' : '',
  ].join(' ');
  const describedBy =
    error !== undefined ? `${id}-error` : hint !== undefined ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          rows={2}
          value={value}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      ) : (
        <input
          id={id}
          type={type}
          onBlur={onBlur}
          inputMode={inputMode}
          maxLength={maxLength}
          value={value}
          placeholder={placeholder}
          aria-describedby={describedBy}
          aria-invalid={error !== undefined}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      )}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-content-muted">
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function SelectInput({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-content">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-content">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function ReadOnlyValue({
  label,
  value,
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium text-content">{label}</span>
      <span className={`text-sm text-content-muted ${mono ? 'font-mono' : ''}`}>{value}</span>
      {hint === undefined ? null : <span className="text-xs text-content-muted">{hint}</span>}
    </div>
  );
}
