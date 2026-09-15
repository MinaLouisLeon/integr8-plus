import {
  type Answers,
  type CompiledForm,
  type ElementId,
  isCalculated,
  migrateAnswers,
} from '@integr8/form-engine';

/**
 * A new form started from the answers of an earlier one — last year's boiler
 * service at the same site, so the make, model and serial are already there.
 *
 * What carries over is what describes the thing being worked on, not the visit:
 *
 * - **Evidence never carries over.** Photos, files, signatures and locations
 *   record this visit; a copy of last year's signature is not a signature.
 * - Calculated and read-only questions are worked out or fixed by the form.
 * - The earlier answers may be against another version of the form: they are
 *   moved across the way a draft is, so a removed question or option is dropped
 *   and a value the new rules reject is kept for the person to see and fix.
 *
 * Nothing is submitted by prefilling; the person reviews every page as usual.
 */

const EVIDENCE = new Set(['signature', 'photo', 'file', 'gps']);

export interface Prefill {
  answers: Record<ElementId, unknown>;
  /** The questions that were filled from the earlier form. */
  filled: ElementId[];
}

export function prefillAnswers(
  previous: CompiledForm,
  current: CompiledForm,
  answers: Answers,
): Prefill {
  const migration = migrateAnswers(previous, current, answers);
  const kept: Record<ElementId, unknown> = {};
  const filled: ElementId[] = [];
  for (const field of current.fields) {
    if (
      !(field.id in migration.answers) ||
      EVIDENCE.has(field.type) ||
      isCalculated(field) ||
      field.readOnly === true
    ) {
      continue;
    }
    kept[field.id] = migration.answers[field.id];
    filled.push(field.id);
  }
  return { answers: kept, filled };
}
