import {
  choiceValues,
  type ConditionClause,
  type ConditionModel,
  dependsOnOf,
  type Expression,
  type Field,
  findField,
  type FormDefinition,
  fromExpression,
  takesValue,
} from '@integr8/form-engine';
import type { TFunction } from '@integr8/i18n';
import { say } from './text';

/**
 * A question's rules, read out as sentences for its card on the canvas:
 * "Shown when Result is Fail", "Required when Hazards includes Gas", "Choices
 * depend on Area". The same clauses the condition builder edits, said rather
 * than shown as dropdowns, so a condition is found without opening the panel.
 *
 * An expression the builder cannot phrase — written by hand, or by AI
 * generation — is still named, as a rule written outside the builder, never
 * rewritten into something it did not say.
 */

/** The words for one clause: the question, the comparison, and the answer the way the question names it. */
export function clauseSentence(
  clause: ConditionClause,
  definition: FormDefinition,
  locale: string,
  t: TFunction,
): string {
  const nameOf = (id: string) => {
    const field = findField(definition, id);
    return field === undefined ? id : say(field.label, locale) || id;
  };
  const sectionName = (id: string) => {
    const section = definition.pages
      .flatMap((page) => page.sections)
      .find((candidate) => candidate.id === id);
    return section === undefined
      ? id
      : say(section.title, locale) || say(section.repeat?.entryLabel, locale) || id;
  };
  const operator = t(`forms.conditions.operator.${clause.operator}`);

  if (clause.subject === 'entry_count') {
    const subject = t('forms.conditions.entryCount', { section: sectionName(clause.field) });
    return `${subject} ${operator} ${clause.value ?? ''}`.trim();
  }

  let subject = nameOf(clause.field);
  if (clause.entries !== undefined) {
    subject = t(
      clause.entries.quantifier === 'every'
        ? 'forms.canvas.rules.inEveryEntry'
        : 'forms.canvas.rules.inAnyEntry',
      { question: subject },
    );
  }
  if (!takesValue(clause.operator)) {
    return `${subject} ${operator}`;
  }
  if (clause.valueField !== undefined) {
    return `${subject} ${operator} ${nameOf(clause.valueField)}`;
  }
  const target = findField(definition, clause.field);
  return `${subject} ${operator} ${answerWords(target, clause.value ?? '', locale, t)}`;
}

/** An answer as the question itself names it: the option's label, or Yes and No. */
function answerWords(
  field: Field | undefined,
  value: string,
  locale: string,
  t: TFunction,
): string {
  if (field === undefined || choiceValues(field) === undefined) {
    return value;
  }
  if (field.type === 'yes_no') {
    return value === 'yes'
      ? t('forms.config.yes')
      : value === 'no'
        ? t('forms.config.no')
        : t('forms.config.notApplicable');
  }
  const option = 'options' in field ? field.options.find((o) => o.value === value) : undefined;
  return option === undefined ? value : say(option.label, locale) || value;
}

/** Every clause joined by "and" or "or". */
export function modelSentence(
  model: ConditionModel,
  definition: FormDefinition,
  locale: string,
  t: TFunction,
): string {
  return model.clauses
    .map((clause) => clauseSentence(clause, definition, locale, t))
    .join(model.match === 'any' ? t('forms.canvas.rules.or') : t('forms.canvas.rules.and'));
}

/**
 * The words for a condition, or for one the builder cannot phrase. `undefined`
 * when there is no condition at all.
 */
export function conditionSentence(
  expression: Expression | undefined,
  definition: FormDefinition,
  locale: string,
  t: TFunction,
): string | undefined {
  if (expression === undefined) {
    return undefined;
  }
  const model = fromExpression(expression, (id) => findField(definition, id));
  return model === undefined || model.clauses.length === 0
    ? t('forms.canvas.rules.advanced')
    : modelSentence(model, definition, locale, t);
}

/** The sentences a question's card shows: when it is shown, when it is required, what its choices follow. */
export function fieldRuleSentences(
  field: Field,
  definition: FormDefinition,
  locale: string,
  t: TFunction,
): string[] {
  const sentences: string[] = [];
  const shown = conditionSentence(field.visibleWhen, definition, locale, t);
  if (shown !== undefined) {
    sentences.push(t('forms.canvas.rules.shown', { condition: shown }));
  }
  const required = conditionSentence(field.requiredWhen, definition, locale, t);
  if (required !== undefined && field.required !== true) {
    sentences.push(t('forms.canvas.rules.required', { condition: required }));
  }
  const parent = dependsOnOf(field)?.field;
  if (parent !== undefined) {
    const parentField = findField(definition, parent);
    sentences.push(
      t('forms.canvas.rules.choices', {
        question: parentField === undefined ? parent : say(parentField.label, locale) || parent,
      }),
    );
  }
  return sentences;
}
