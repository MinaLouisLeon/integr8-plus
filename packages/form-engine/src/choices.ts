import type { RuleValue } from './evaluate.js';
import { type DependsOn, dependsOnOf, type Field } from './field-types.js';
import type { ElementId } from './ids.js';

/**
 * Dependent choices: which of a choice field's options are on offer, given the
 * answer to the field it depends on.
 *
 * "Area" is answered "Kitchen", so "Room" offers "Kitchen sink" and "Hob" but
 * not "Bath". The rule is the same on every platform, which is why it lives here
 * and not in a renderer: the server rejects an answer the phone would not have
 * offered, and the phone offers exactly what the server will accept.
 */

export interface AvailableOptions {
  /** The option values on offer right now, in the field's own order. */
  readonly options: readonly string[];
  /**
   * Whether the field this one depends on has an answer. Without one nothing is
   * offered, and a renderer says which question to answer first.
   */
  readonly parentAnswered: boolean;
}

/** The field whose answer decides this field's options, or `undefined`. */
export function dependentChoiceParent(field: Field): ElementId | undefined {
  return dependsOnOf(field)?.field;
}

/**
 * What a field offers given its parent's value as a rule sees it — a text
 * value for a single choice, options for a multi-select, `undefined` for
 * unanswered or hidden. `undefined` when the field's options depend on nothing.
 */
export function availableOptions(
  field: Field,
  parent: RuleValue | undefined,
): AvailableOptions | undefined {
  const dependsOn = dependsOnOf(field);
  if (dependsOn === undefined || !('options' in field)) {
    return undefined;
  }
  if (parent === undefined) {
    return { options: [], parentAnswered: false };
  }
  const chosen: readonly string[] =
    parent.type === 'options' ? parent.value : parent.type === 'text' ? [parent.value] : [];
  const options = field.options
    .filter((option) => {
      const revealedBy = revealing(dependsOn, option.value);
      return revealedBy === undefined || revealedBy.some((value) => chosen.includes(value));
    })
    .map((option) => option.value);
  return { options, parentAnswered: true };
}

/** The parent values that reveal an option, or `undefined` when it is always offered. */
export function revealing(dependsOn: DependsOn, option: string): readonly string[] | undefined {
  // `constructor` is a legal option value, and a property of every plain object.
  return Object.prototype.hasOwnProperty.call(dependsOn.options, option)
    ? dependsOn.options[option]
    : undefined;
}
