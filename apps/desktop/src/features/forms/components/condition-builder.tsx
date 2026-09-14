import {
  canCompareWithField,
  choiceValues,
  clauseProblem,
  type ConditionClause,
  type ConditionModel,
  type ConditionOperator,
  describeFieldType,
  type Expression,
  type Field,
  fieldsOf,
  findField,
  type FormDefinition,
  fromExpression,
  operatorsFor,
  referencedFields,
  subtreeIds,
  takesValue,
  toExpression,
} from '@integr8/form-engine';
import { useTranslation } from '@integr8/i18n';
import { useId, useState } from 'react';
import { Button } from '~/components/ui';
import { say } from '../model/text';
import { withLocalOffset } from './form-renderer';

/**
 * "Show this when *Result* is *Fail*" — conditions as sentences, never syntax.
 *
 * Each clause is three dropdowns and, when the comparison needs one, an answer
 * picked the way the question itself is answered: a list of the question's own
 * options, a date picker, a number box. The admin never types an option's
 * stored value or an operator symbol.
 *
 * A clause that is not finished yet stays on screen but is left out of the
 * saved rule until it is, so a half-built condition never hides a question in
 * the preview.
 */

export type Lookup = (id: string) => Field | undefined;

export const lookupIn =
  (definition: FormDefinition): Lookup =>
  (id) =>
    findField(definition, id);

/** The saved form of a model: complete clauses only, or `undefined` when there are none. */
export function completeExpression(model: ConditionModel, lookup: Lookup): Expression | undefined {
  const complete = model.clauses.filter((clause) => clauseProblem(clause, lookup) === undefined);
  return complete.length === 0 ? undefined : toExpression({ ...model, clauses: complete }, lookup);
}

export function newClause(field: Field): ConditionClause {
  return { field: field.id, operator: operatorsFor(field)[0]! };
}

interface ConditionBuilderProps {
  model: ConditionModel;
  onChange: (model: ConditionModel) => void;
  /** The questions a clause may read, in form order. */
  candidates: readonly Field[];
  lookup: Lookup;
  locale: string;
  /** In a check, the field being checked is offered first, as "This answer". */
  selfId?: string | undefined;
  lead: string;
}

export function ConditionBuilder({
  model,
  onChange,
  candidates,
  lookup,
  locale,
  selfId,
  lead,
}: ConditionBuilderProps) {
  const { t } = useTranslation();
  const incomplete = model.clauses.some((clause) => clauseProblem(clause, lookup) !== undefined);

  const setClause = (index: number, clause: ConditionClause) =>
    onChange({
      ...model,
      clauses: model.clauses.map((current, at) => (at === index ? clause : current)),
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-content">
        <span>{lead}</span>
        {model.clauses.length > 1 ? (
          <select
            aria-label={lead}
            value={model.match}
            onChange={(event) =>
              onChange({ ...model, match: event.target.value as ConditionModel['match'] })
            }
            className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm"
          >
            <option value="all">{t('forms.conditions.match.all')}</option>
            <option value="any">{t('forms.conditions.match.any')}</option>
          </select>
        ) : null}
      </div>

      <ol className="flex flex-col gap-3">
        {model.clauses.map((clause, index) => (
          <ClauseRow
            // Clauses have no identity of their own; position is what the person sees.
            key={index}
            clause={clause}
            candidates={candidates}
            lookup={lookup}
            locale={locale}
            selfId={selfId}
            onChange={(next) => setClause(index, next)}
            onRemove={() =>
              onChange({ ...model, clauses: model.clauses.filter((_, at) => at !== index) })
            }
          />
        ))}
      </ol>

      {incomplete ? (
        <p className="text-xs text-content-muted">{t('forms.conditions.incomplete')}</p>
      ) : null}

      {candidates.length === 0 ? null : (
        <div>
          <Button
            variant="secondary"
            onClick={() =>
              onChange({ ...model, clauses: [...model.clauses, newClause(candidates[0]!)] })
            }
          >
            {t('forms.conditions.add')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ClauseRow({
  clause,
  candidates,
  lookup,
  locale,
  selfId,
  onChange,
  onRemove,
}: {
  clause: ConditionClause;
  candidates: readonly Field[];
  lookup: Lookup;
  locale: string;
  selfId: string | undefined;
  onChange: (clause: ConditionClause) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const target = lookup(clause.field);
  const problem = clauseProblem(clause, lookup);
  const operators = target === undefined ? [] : operatorsFor(target);
  const comparingField = clause.valueField !== undefined;

  const name = (field: Field) =>
    field.id === selfId ? t('forms.conditions.thisAnswer') : say(field.label, locale) || field.id;

  const selectClass = 'rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm';

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border-subtle bg-surface-muted p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t('forms.conditions.question')}
          value={clause.field}
          onChange={(event) => {
            const field = lookup(event.target.value);
            if (field !== undefined) {
              onChange(newClause(field));
            }
          }}
          className={`${selectClass} max-w-[14rem]`}
        >
          {target === undefined ? (
            <option value="">{t('forms.conditions.chooseQuestion')}</option>
          ) : null}
          {candidates.map((field) => (
            <option key={field.id} value={field.id}>
              {name(field)}
            </option>
          ))}
        </select>

        <select
          aria-label={t('forms.conditions.comparison')}
          value={clause.operator}
          onChange={(event) => {
            const operator = event.target.value as ConditionOperator;
            onChange(
              takesValue(operator)
                ? {
                    field: clause.field,
                    operator,
                    ...(clause.value === undefined ? {} : { value: clause.value }),
                    ...(clause.valueField !== undefined && canCompareWithField(operator)
                      ? { valueField: clause.valueField }
                      : {}),
                  }
                : { field: clause.field, operator },
            );
          }}
          className={selectClass}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {t(`forms.conditions.operator.${operator}`)}
            </option>
          ))}
        </select>

        {target !== undefined && takesValue(clause.operator) ? (
          <>
            {canCompareWithField(clause.operator) ? (
              <select
                aria-label={t('forms.conditions.compareWith')}
                value={comparingField ? 'field' : 'value'}
                onChange={(event) => {
                  const other = candidates.find(
                    (field) =>
                      field.id !== target.id &&
                      describeFieldType(field.type).valueType ===
                        describeFieldType(target.type).valueType,
                  );
                  onChange(
                    event.target.value === 'field' && other !== undefined
                      ? { field: clause.field, operator: clause.operator, valueField: other.id }
                      : { field: clause.field, operator: clause.operator },
                  );
                }}
                className={selectClass}
              >
                <option value="value">{t('forms.conditions.aValue')}</option>
                <option value="field">{t('forms.conditions.anotherAnswer')}</option>
              </select>
            ) : null}

            {comparingField ? (
              <select
                aria-label={t('forms.conditions.anotherAnswer')}
                value={clause.valueField}
                onChange={(event) => onChange({ ...clause, valueField: event.target.value })}
                className={`${selectClass} max-w-[14rem]`}
              >
                {candidates
                  .filter(
                    (field) =>
                      field.id !== target.id &&
                      describeFieldType(field.type).valueType ===
                        describeFieldType(target.type).valueType,
                  )
                  .map((field) => (
                    <option key={field.id} value={field.id}>
                      {name(field)}
                    </option>
                  ))}
              </select>
            ) : (
              <ValueInput
                id={id}
                field={target}
                operator={clause.operator}
                value={clause.value}
                locale={locale}
                onChange={(value) =>
                  onChange({
                    field: clause.field,
                    operator: clause.operator,
                    ...(value === '' ? {} : { value }),
                  })
                }
              />
            )}
          </>
        ) : null}

        <Button variant="ghost" onClick={onRemove} aria-label={t('forms.conditions.remove')}>
          ✕
        </Button>
      </div>
      {problem === undefined ? null : (
        <p className="text-xs text-danger">{t(`forms.conditions.problem.${problem}`)}</p>
      )}
    </li>
  );
}

function ValueInput({
  id,
  field,
  operator,
  value,
  locale,
  onChange,
}: {
  id: string;
  field: Field;
  operator: ConditionOperator;
  value: string | undefined;
  locale: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const className = 'rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-sm';
  const label = t('forms.conditions.value');

  const choices = choiceValues(field);
  if (choices !== undefined || operator === 'includes' || operator === 'does_not_include') {
    const options =
      field.type === 'yes_no'
        ? choices!.map((choice) => ({
            value: choice,
            label:
              choice === 'yes'
                ? t('forms.config.yes')
                : choice === 'no'
                  ? t('forms.config.no')
                  : t('forms.config.notApplicable'),
          }))
        : 'options' in field
          ? field.options.map((option) => ({
              value: option.value,
              label: say(option.label, locale),
            }))
          : [];
    return (
      <select
        id={id}
        aria-label={label}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
        className={className}
      >
        <option value="">{t('forms.conditions.choose')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label || option.value}
          </option>
        ))}
      </select>
    );
  }

  switch (describeFieldType(field.type).valueType) {
    case 'number':
      return (
        <input
          id={id}
          aria-label={label}
          type="text"
          inputMode="decimal"
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value.trim())}
          className={`${className} w-28`}
        />
      );
    case 'date':
    case 'time':
      return (
        <input
          id={id}
          aria-label={label}
          type={describeFieldType(field.type).valueType}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      );
    case 'datetime':
      return (
        <input
          id={id}
          aria-label={label}
          type="datetime-local"
          value={value?.slice(0, 16) ?? ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? '' : withLocalOffset(event.target.value))
          }
          className={className}
        />
      );
    default:
      return (
        <input
          id={id}
          aria-label={label}
          type="text"
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value)}
          className={className}
        />
      );
  }
}

/**
 * "When to show" for a question, section or page.
 *
 * Holds the clauses being edited, and writes the complete ones back as the
 * element's `visibleWhen`. Keyed by element id in the parent, so selecting
 * something else starts fresh from what that element has.
 */
export function VisibilityEditor({
  definition,
  elementId,
  expression,
  locale,
  onChange,
}: {
  definition: FormDefinition;
  elementId: string;
  expression: Expression | undefined;
  locale: string;
  onChange: (expression: Expression | undefined) => void;
}) {
  const { t } = useTranslation();
  const lookup = lookupIn(definition);
  const [model, setModel] = useState<ConditionModel | undefined>(() =>
    fromExpression(expression, lookup),
  );

  // A question cannot depend on itself, and a section cannot depend on its own questions.
  const own = new Set(subtreeIds(definition, elementId));
  const candidates = fieldsOf(definition).filter((field) => !own.has(field.id));

  if (model === undefined) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-content-muted">
          {expression !== undefined &&
          referencedFields(expression).some((id) => lookup(id) === undefined)
            ? t('forms.conditions.broken')
            : t('forms.conditions.advanced')}
        </p>
        <div>
          <Button
            variant="secondary"
            onClick={() => {
              setModel({ match: 'all', clauses: [] });
              onChange(undefined);
            }}
          >
            {t('forms.conditions.removeAdvanced')}
          </Button>
        </div>
      </div>
    );
  }

  if (model.clauses.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-content-muted">{t('forms.conditions.always')}</p>
        {candidates.length === 0 ? null : (
          <Button
            variant="secondary"
            onClick={() => setModel({ match: 'all', clauses: [newClause(candidates[0]!)] })}
          >
            {t('forms.conditions.addFirst')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <ConditionBuilder
      model={model}
      candidates={candidates}
      lookup={lookup}
      locale={locale}
      lead={t('forms.conditions.showWhen')}
      onChange={(next) => {
        setModel(next);
        onChange(completeExpression(next, lookup));
      }}
    />
  );
}
