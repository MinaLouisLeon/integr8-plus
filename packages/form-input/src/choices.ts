import {
  type AvailableOptions,
  type CompiledForm,
  dependentChoiceParent,
  type Field,
  type FormView,
  type Option,
  touchKey,
} from '@integr8/form-engine';
import { say } from './text.js';

/**
 * What the view says about one question, for a renderer about to draw it:
 * whether it must be answered right now, and — for a choice whose options
 * depend on another answer — which options to offer and what to say when there
 * are none. Both renderers read these, so a question required "only when" shows
 * its mark at the same moment on the phone and on the desktop.
 */

/** Whether a question must be answered right now, in the entry given or at the top level. */
export function isRequiredNow(view: FormView, field: Field, entry?: string): boolean {
  return view.required.get(touchKey(field.id, entry)) === true;
}

export interface DependentChoices extends AvailableOptions {
  /** The question whose answer decides what is offered, as the person sees it named. */
  parentLabel: string;
}

/**
 * For a choice question whose options depend on another answer: what it offers
 * right now and which question it follows. `undefined` for any other question,
 * which offers all of its options.
 */
export function dependentChoices(
  form: CompiledForm,
  view: FormView,
  field: Field,
  locale: string,
  entry?: string,
): DependentChoices | undefined {
  const parent = dependentChoiceParent(field);
  const available = view.availableOptions.get(touchKey(field.id, entry));
  if (parent === undefined || available === undefined) {
    return undefined;
  }
  const parentField = form.elements.get(parent)?.field;
  return {
    ...available,
    parentLabel: parentField === undefined ? parent : say(parentField.label, locale) || parent,
  };
}

/** The options to draw: all of them, or only those on offer right now. */
export function offeredOptions<T extends Pick<Option, 'value'>>(
  options: readonly T[],
  available: readonly string[] | undefined,
): readonly T[] {
  return available === undefined
    ? options
    : options.filter((option) => available.includes(option.value));
}

/**
 * A multi-select answer after ticking or unticking one option, in the form's
 * option order — keeping only options still on offer, so a choice the parent
 * no longer reveals goes the moment the person touches the question, having
 * been named as a problem until then.
 */
export function toggleOffered(
  options: readonly Pick<Option, 'value'>[],
  available: readonly string[] | undefined,
  selected: readonly string[],
  value: string,
  checked: boolean,
): string[] {
  const offered = offeredOptions(options, available).map((option) => option.value);
  return offered.filter(
    (candidate) =>
      (checked && candidate === value) || (candidate !== value && selected.includes(candidate)),
  );
}
