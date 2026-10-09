import type { Field, FieldOf, FieldType } from '@integr8/form-engine';
import type { MediaAdapter } from '../media.js';

/** What every widget is given. The widget never decides visibility, validity or calculation. */
export interface WidgetProps<T extends FieldType = FieldType> {
  field: FieldOf<T>;
  value: unknown;
  /** The id of the control a label points at, or of the group's fieldset. */
  id: string;
  /** The question, as shown — for naming controls inside a group. */
  label: string;
  describedBy: string | undefined;
  invalid: boolean;
  /** Whether it must be answered right now: fixed, or because `requiredWhen` holds. */
  required: boolean;
  /** For a choice whose options depend on another answer: the values on offer. `undefined` offers all. */
  available: readonly string[] | undefined;
  disabled: boolean;
  locale: string;
  media: MediaAdapter | undefined;
  onAnswer: (value: unknown) => void;
  onClear: () => void;
  onBlur: () => void;
}

/**
 * Questions answered with more than one control, or with none that can carry a
 * label: announced as a group, named by a legend.
 */
export function isGroup(field: Field): boolean {
  switch (field.type) {
    case 'radio':
    case 'multi_select':
    case 'yes_no':
    case 'rating':
    case 'signature':
    case 'photo':
    case 'file':
    case 'gps':
      return true;
    default:
      return false;
  }
}

export const inputClass = [
  'w-full rounded-md border bg-surface px-3 py-2 text-start text-sm text-content',
  'disabled:cursor-not-allowed disabled:opacity-70',
  'aria-[invalid=true]:border-danger border-border-subtle',
].join(' ');

export const buttonClass = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60',
  secondary:
    'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle bg-surface px-4 py-2 text-sm font-medium text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm text-content hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60',
} as const;
