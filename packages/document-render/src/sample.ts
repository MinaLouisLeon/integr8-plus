import type { CompiledForm, Field } from '@integr8/form-engine';
import { type DocumentLocale, wordsFor } from './words.js';

/**
 * Made-up answers for every question of a form, for a preview made before
 * the form has a real submission (1.3.0 decision 12): plausible values of the
 * right kind, so every block of a template shows something. Photos,
 * signatures and files stay empty — there is no picture to show — and a
 * calculated question is left for the form to work out.
 */

/** Entries a repeating section gets in a sample. */
const SAMPLE_ENTRIES = 3;

function sampleValue(field: Field, locale: DocumentLocale, today: string, row: number): unknown {
  const words = wordsFor(locale);
  switch (field.type) {
    case 'text':
      return row === 0 ? words.sampleAnswer : `${words.sampleAnswer} ${String(row + 1)}`;
    case 'long_text':
      return words.sampleLongAnswer;
    case 'number':
      return field.calculation === undefined ? 12 + row : undefined;
    case 'decimal':
      return field.calculation === undefined ? (2.5 + row).toFixed(field.decimalPlaces) : undefined;
    case 'date':
      return today;
    case 'time':
      return '09:30';
    case 'datetime':
      return `${today}T09:30:00.000Z`;
    case 'dropdown':
    case 'radio':
      return field.options[row % Math.max(1, field.options.length)]?.value;
    case 'multi_select':
      return field.options.slice(0, 2).map((option) => option.value);
    case 'checkbox':
      return true;
    case 'yes_no':
      return 'yes';
    case 'rating':
      return Math.max(1, field.scale - 1);
    case 'gps':
      return { latitude: '30.044420', longitude: '31.235712' };
    case 'barcode':
      return '5012345678900';
    default:
      return undefined;
  }
}

export function sampleAnswers(
  form: CompiledForm,
  locale: DocumentLocale,
  today: string,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const entries = new Map<string, Record<string, unknown>[]>();
  for (const field of form.fields) {
    const section = form.elements.get(field.id)?.entries;
    if (section === undefined) {
      const value = sampleValue(field, locale, today, 0);
      if (value !== undefined) {
        answers[field.id] = value;
      }
      continue;
    }
    let rows = entries.get(section);
    if (rows === undefined) {
      rows = Array.from({ length: SAMPLE_ENTRIES }, () => ({}));
      entries.set(section, rows);
    }
    rows.forEach((values, index) => {
      const value = sampleValue(field, locale, today, index);
      if (value !== undefined) {
        values[field.id] = value;
      }
    });
  }
  for (const [section, rows] of entries) {
    answers[section] = rows.map((values, index) => ({ id: `sample_${String(index + 1)}`, values }));
  }
  return answers;
}
