import {
  type Answers,
  type CompiledForm,
  type ElementId,
  type Entry,
  type Field,
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
 * - **Entries carry over** — every appliance at the site, with its make and
 *   model — keeping their ids, each without its evidence. An entry left with
 *   nothing that carries over is not carried at all (P13b).
 *
 * Nothing is submitted by prefilling; the person reviews every page as usual.
 */

const EVIDENCE = new Set(['signature', 'photo', 'file', 'gps']);

export interface Prefill {
  answers: Record<ElementId, unknown>;
  /** The questions that were filled from the earlier form, each once however many entries it was in. */
  filled: ElementId[];
}

const carries = (field: Field) =>
  !EVIDENCE.has(field.type) && !isCalculated(field) && field.readOnly !== true;

export function prefillAnswers(
  previous: CompiledForm,
  current: CompiledForm,
  answers: Answers,
): Prefill {
  const migration = migrateAnswers(previous, current, answers);
  const kept: Record<ElementId, unknown> = {};
  const filled: ElementId[] = [];
  const note = (id: ElementId) => {
    if (!filled.includes(id)) {
      filled.push(id);
    }
  };

  const elements = [...current.elements.values()].sort((a, b) => a.index - b.index);
  for (const element of elements) {
    if (element.repeat !== undefined) {
      const entries = migration.answers[element.id];
      if (!Array.isArray(entries)) {
        continue;
      }
      const carried: Entry[] = [];
      for (const entry of entries as Entry[]) {
        const values: Record<ElementId, unknown> = {};
        for (const [id, value] of Object.entries(entry.values)) {
          const field = current.elements.get(id)?.field;
          if (field !== undefined && carries(field)) {
            values[id] = value;
          }
        }
        if (Object.keys(values).length > 0) {
          carried.push({ id: entry.id, values });
        }
      }
      if (carried.length > 0) {
        kept[element.id] = carried;
        for (const entry of carried) {
          Object.keys(entry.values).forEach(note);
        }
      }
      continue;
    }
    const field = element.field;
    if (
      field === undefined ||
      element.entries !== undefined ||
      !(field.id in migration.answers) ||
      !carries(field)
    ) {
      continue;
    }
    kept[field.id] = migration.answers[field.id];
    note(field.id);
  }

  // Filled questions in reading order, as the notice lists them.
  const position = (id: ElementId) => current.elements.get(id)?.index ?? 0;
  filled.sort((a, b) => position(a) - position(b));
  return { answers: kept, filled };
}
