import { type CompiledForm, compileDefinition } from '../compile.js';
import {
  DEFINITION_SCHEMA_VERSION,
  type FormDefinition,
  type Page,
  type Section,
} from '../definition.js';
import type { ComparisonOperator, Expression } from '../expression.js';
import type { Field, FieldOf, FieldType } from '../field-types.js';

/**
 * Small builders so a test reads like the form it describes.
 *
 *   const form = compiled(
 *     fields(
 *       field('radio', 'result', { options: options('pass', 'fail'), required: true }),
 *       field('text', 'reason', { visibleWhen: eq(answer('result'), text('fail')) }),
 *     ),
 *   );
 */

export const label = (en: string) => ({ en });

export const text = (value: string): Expression => ({ kind: 'text', value });
export const num = (value: string): Expression => ({ kind: 'number', value });
export const bool = (value: boolean): Expression => ({ kind: 'boolean', value });
export const date = (value: string): Expression => ({ kind: 'date', value });
export const time = (value: string): Expression => ({ kind: 'time', value });
export const datetime = (value: string): Expression => ({ kind: 'datetime', value });
export const today = (): Expression => ({ kind: 'today' });
export const answer = (field: string): Expression => ({ kind: 'answer', field });
export const answered = (field: string): Expression => ({ kind: 'answered', field });
export const includes = (field: string, option: string): Expression => ({
  kind: 'includes',
  field,
  option,
});
export const not = (operand: Expression): Expression => ({ kind: 'not', operand });
export const all = (...operands: Expression[]): Expression => ({ kind: 'all', operands });
export const any = (...operands: Expression[]): Expression => ({ kind: 'any', operands });

const comparison =
  (operator: ComparisonOperator) =>
  (left: Expression, right: Expression): Expression => ({ kind: 'compare', operator, left, right });

export const eq = comparison('eq');
export const ne = comparison('ne');
export const lt = comparison('lt');
export const le = comparison('le');
export const gt = comparison('gt');
export const ge = comparison('ge');

export const plus = (left: Expression, right: Expression): Expression => ({
  kind: 'arithmetic',
  operator: 'add',
  left,
  right,
});
export const minus = (left: Expression, right: Expression): Expression => ({
  kind: 'arithmetic',
  operator: 'subtract',
  left,
  right,
});
export const times = (left: Expression, right: Expression): Expression => ({
  kind: 'arithmetic',
  operator: 'multiply',
  left,
  right,
});
export const over = (left: Expression, right: Expression): Expression => ({
  kind: 'arithmetic',
  operator: 'divide',
  left,
  right,
});

export const options = (...values: string[]) =>
  values.map((value) => ({ value, label: label(value) }));

type Required<T extends FieldType> = T extends 'decimal'
  ? { decimalPlaces: number }
  : T extends 'rating'
    ? { scale: number }
    : T extends 'dropdown' | 'radio' | 'multi_select'
      ? { options: ReturnType<typeof options> }
      : unknown;

const REQUIRED_DEFAULTS: Partial<Record<FieldType, object>> = {
  decimal: { decimalPlaces: 2 },
  rating: { scale: 5 },
  dropdown: { options: options('a', 'b', 'c') },
  radio: { options: options('a', 'b', 'c') },
  multi_select: { options: options('a', 'b', 'c') },
};

/** A field of `type`, with sensible values for anything the type requires. */
export function field<T extends FieldType>(
  type: T,
  id: string,
  extra: Partial<Omit<FieldOf<T>, 'type' | 'id'>> & Partial<Required<T>> = {},
): FieldOf<T> {
  return {
    id,
    type,
    label: label(id),
    ...REQUIRED_DEFAULTS[type],
    ...extra,
  } as unknown as FieldOf<T>;
}

export function section(
  id: string,
  fieldsInSection: Field[],
  extra: Partial<Section> = {},
): Section {
  return { id, fields: fieldsInSection, ...extra };
}

export function page(id: string, sections: Section[], extra: Partial<Page> = {}): Page {
  return { id, sections, ...extra };
}

export function definition(pages: Page[]): FormDefinition {
  return { schemaVersion: DEFINITION_SCHEMA_VERSION, title: label('Test form'), pages };
}

/** One page, one section, these fields. The common case. */
export function fields(...members: Field[]): FormDefinition {
  return definition([page('page_1', [section('section_1', members)])]);
}

/** Compiles, or fails the test with every issue listed. */
export function compiled(input: FormDefinition): CompiledForm {
  const result = compileDefinition(input);
  if (!result.ok) {
    throw new Error(
      `Expected the definition to compile:\n${result.issues.map((issue) => `  ${issue.code}: ${issue.message}`).join('\n')}`,
    );
  }
  return result.form;
}

/** Compiles, expecting failure, and returns the issues. */
export function issuesOf(input: unknown) {
  const result = compileDefinition(input);
  if (result.ok) {
    throw new Error('Expected the definition to be refused, and it compiled');
  }
  return result.issues;
}

export const MEDIA_ID = '6f1c2a4e-9b1d-4c3e-8a2f-1d2e3f4a5b6c';

export const photo = (byteSize = 1_000, contentType = 'image/jpeg') => ({
  mediaId: MEDIA_ID,
  contentType,
  byteSize,
});
