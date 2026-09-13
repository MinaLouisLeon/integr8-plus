import type { CompiledForm } from './compile.js';
import { compileDefinition, type CompileResult } from './compile.js';
import { type Answers, ownAnswer } from './evaluate.js';
import {
  choiceValues,
  type Field,
  hasAnswerShape,
  isAnswered,
  isCalculated,
  validateAnswer,
} from './field-types.js';
import type { ElementId } from './ids.js';

/**
 * Versions, and what happens to a draft when the form changes under it.
 *
 *   form ──▶ form_version (draft) ──publish──▶ form_version (published, immutable)
 *                                                    ▲
 *                                   submission ──────┘ bound by form_version_id
 *
 * A published version never changes — not its fields, not its rules, not a
 * label. That is enforced by the database (migration 0006), not here: this
 * module could not stop a `update` statement, and a guarantee that depends on
 * every future caller being careful is not a guarantee. What lives here is the
 * logic that has to be identical on every platform.
 *
 * Editing a form means creating a *new* draft version and publishing it. Every
 * submission already made keeps pointing at the version it was made against,
 * and renders against that version forever.
 */

export const FORM_VERSION_STATUSES = ['draft', 'published'] as const;
export type FormVersionStatus = (typeof FORM_VERSION_STATUSES)[number];

/**
 * The check a definition must pass before it may become a published version.
 *
 * The same compilation a renderer does, named for where it matters. The
 * database stores whatever it is given, so the service that publishes must call
 * this first; P07's publish flow and the API's publish endpoint both do.
 */
export function prepareForPublish(definition: unknown): CompileResult {
  return compileDefinition(definition);
}

export type DroppedReason =
  /** The field is not in the new version. */
  | 'field_removed'
  /** Same id, different type: a number answer means nothing to a date field. */
  | 'type_changed'
  /** The new version calculates this field; a typed value would be ignored anyway. */
  | 'now_calculated'
  /** A choice that the new version no longer offers. */
  | 'option_removed';

export interface AnswerMigration {
  /** Answers that carry over, ready to resume against the new version. */
  readonly answers: Record<ElementId, unknown>;
  /** Carried over unchanged, in the new version's field order. */
  readonly carried: readonly ElementId[];
  /** Not carried over, and why. */
  readonly dropped: readonly { field: ElementId; reason: DroppedReason }[];
  /** Carried, but with some options removed from a multi-select. */
  readonly trimmed: readonly { field: ElementId; removed: readonly string[] }[];
  /**
   * Carried, but the new version's rules reject them — a new maximum, a longer
   * minimum. Kept, so the person sees their value and the reason, rather than a
   * blank field and no explanation.
   */
  readonly nowInvalid: readonly ElementId[];
}

/**
 * Moves a draft's answers from a superseded version to its successor.
 *
 * An engineer starts a job sheet on Monday against version 3. On Tuesday the
 * office publishes version 4. The draft on the phone was bound to version 3 and
 * has not been submitted. Submitting it against 3 would be legal — 3 still
 * exists — but the office changed the form for a reason, so the app offers to
 * move the draft to 4, and this is what decides what survives.
 *
 * Field ids are stable across versions, which is what makes this a lookup rather
 * than a guess. Nothing is inferred from labels.
 *
 * The report is the point as much as the answers are: the person has to be
 * told that "Reason for delay" is gone and their text went with it.
 */
export function migrateAnswers(
  from: CompiledForm,
  to: CompiledForm,
  answers: Answers,
): AnswerMigration {
  const migrated: Record<ElementId, unknown> = {};
  const carried: ElementId[] = [];
  const dropped: { field: ElementId; reason: DroppedReason }[] = [];
  const trimmed: { field: ElementId; removed: string[] }[] = [];
  const nowInvalid: ElementId[] = [];

  // Walk the old version, so that a field removed in the new one is noticed.
  for (const previous of from.fields) {
    const value = ownAnswer(answers, previous.id);
    if (!isAnswered(previous, value)) {
      continue;
    }

    const next = to.elements.get(previous.id)?.field;
    const reason = incompatibility(previous, next, value);
    if (reason !== undefined || next === undefined) {
      dropped.push({ field: previous.id, reason: reason ?? 'field_removed' });
      continue;
    }

    let carriedValue = value;
    if (next.type === 'multi_select' && Array.isArray(value)) {
      const offered = choiceValues(next) ?? [];
      const kept = (value as string[]).filter((option) => offered.includes(option));
      const removed = (value as string[]).filter((option) => !offered.includes(option));
      if (kept.length === 0) {
        dropped.push({ field: previous.id, reason: 'option_removed' });
        continue;
      }
      if (removed.length > 0) {
        trimmed.push({ field: previous.id, removed });
        carriedValue = kept;
      }
    }

    migrated[previous.id] = carriedValue;
    carried.push(previous.id);
    if (validateAnswer(next, carriedValue).length > 0) {
      nowInvalid.push(previous.id);
    }
  }

  // Report in the new version's reading order, which is the order the person
  // will meet these fields in.
  const position = (id: ElementId) => to.elements.get(id)?.index ?? Number.MAX_SAFE_INTEGER;
  carried.sort((a, b) => position(a) - position(b));
  nowInvalid.sort((a, b) => position(a) - position(b));

  return { answers: migrated, carried, dropped, trimmed, nowInvalid };
}

function incompatibility(
  previous: Field,
  next: Field | undefined,
  value: unknown,
): DroppedReason | undefined {
  if (next === undefined) {
    return 'field_removed';
  }
  if (next.type !== previous.type) {
    return 'type_changed';
  }
  if (isCalculated(next)) {
    return 'now_calculated';
  }
  if (!hasAnswerShape(next, value)) {
    return 'type_changed';
  }
  if (
    (next.type === 'dropdown' || next.type === 'radio' || next.type === 'yes_no') &&
    !(choiceValues(next) ?? []).includes(value as string)
  ) {
    return 'option_removed';
  }
  return undefined;
}
