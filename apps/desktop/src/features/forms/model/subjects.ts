import {
  clauseProblem,
  type ClauseProblem,
  type ConditionClause,
  describeFieldType,
  ENTRY_COUNT_OPERATORS,
  type Field,
  type FormDefinition,
  locate,
  operatorsFor,
  type Section,
  subtreeIds,
} from '@integr8/form-engine';

/**
 * What a condition, a check or a calculation may read, from where it sits
 * (P13b).
 *
 * A question asked once per entry of a repeatable section is read plainly from
 * inside that section — "this appliance's make". From anywhere else it is read
 * across the entries, so a condition must say whether *any* entry or *every*
 * entry must match, and a calculation takes a total, the smallest or the
 * largest. A repeatable section can also be counted: "Number of Appliances".
 */

export type Subject =
  | {
      kind: 'field';
      field: Field;
      /** Set when the question is asked once per entry of another section: it needs a quantifier. */
      across: Section | undefined;
    }
  | { kind: 'entry_count'; section: Section };

/** The repeatable section an element is asked in, if any: where its rules read entries plainly. */
export function repeatingScope(definition: FormDefinition, id: string): Section | undefined {
  const at = locate(definition, id);
  if (at?.kind !== 'field') {
    return undefined;
  }
  const section = definition.pages[at.page]!.sections[at.section!]!;
  return section.repeat === undefined ? undefined : section;
}

/** Every repeatable section, in form order. */
export function repeatableSections(definition: FormDefinition): Section[] {
  return definition.pages.flatMap((page) =>
    page.sections.filter((section) => section.repeat !== undefined),
  );
}

/**
 * The subjects a condition on `elementId` may use, in form order: each
 * repeatable section's count just before its questions. An element never reads
 * itself or anything it contains, and a question in a repeatable section does
 * not count its own section.
 */
export function subjectsFor(definition: FormDefinition, elementId: string): Subject[] {
  const own = new Set(subtreeIds(definition, elementId));
  const scope = repeatingScope(definition, elementId);
  const subjects: Subject[] = [];
  for (const page of definition.pages) {
    for (const section of page.sections) {
      const across = section.repeat !== undefined && section.id !== scope?.id;
      if (across && !own.has(section.id)) {
        subjects.push({ kind: 'entry_count', section });
      }
      for (const field of section.fields) {
        if (!own.has(field.id)) {
          subjects.push({ kind: 'field', field, across: across ? section : undefined });
        }
      }
    }
  }
  return subjects;
}

/** The subject's value in the question dropdown. Element ids never contain `#`. */
export function subjectKey(subject: Subject): string {
  return subject.kind === 'field' ? subject.field.id : `#count:${subject.section.id}`;
}

/** The dropdown value of the subject a clause reads. */
export function clauseSubjectKey(clause: ConditionClause): string {
  return clause.subject === 'entry_count' ? `#count:${clause.field}` : clause.field;
}

/** A fresh clause about a subject, with the first comparison it allows. */
export function clauseFor(subject: Subject): ConditionClause {
  if (subject.kind === 'entry_count') {
    return {
      field: subject.section.id,
      operator: ENTRY_COUNT_OPERATORS[0]!,
      subject: 'entry_count',
    };
  }
  return {
    field: subject.field.id,
    operator: operatorsFor(subject.field)[0]!,
    ...(subject.across === undefined
      ? {}
      : { entries: { section: subject.across.id, quantifier: 'some' as const } }),
  };
}

/** What stays of a clause when its comparison or value changes: which question, and how it is read. */
export function clauseBase(
  clause: ConditionClause,
): Pick<ConditionClause, 'field' | 'entries' | 'subject'> {
  return {
    field: clause.field,
    ...(clause.entries === undefined ? {} : { entries: clause.entries }),
    ...(clause.subject === undefined ? {} : { subject: clause.subject }),
  };
}

export type SubjectProblem = ClauseProblem | 'quantifier_required';

/**
 * What is wrong with a clause, where it sits: the engine's problems, and a
 * question of another repeatable section read without saying "any" or "every"
 * (or with a quantifier where none belongs).
 */
export function subjectProblem(
  clause: ConditionClause,
  lookup: (id: string) => Field | undefined,
  subjects: readonly Subject[],
): SubjectProblem | undefined {
  const problem = clauseProblem(clause, lookup);
  if (problem !== undefined || clause.subject === 'entry_count') {
    return problem;
  }
  const subject = subjects.find(
    (candidate) => candidate.kind === 'field' && candidate.field.id === clause.field,
  );
  if (subject?.kind !== 'field') {
    return undefined;
  }
  return (subject.across?.id ?? undefined) === clause.entries?.section
    ? undefined
    : 'quantifier_required';
}

/**
 * The other answers a clause may compare with: the same kind of value, and
 * readable where the clause reads — outside every repeatable section, or in the
 * same section as the question being quantified.
 */
export function comparableSubjects(
  clause: ConditionClause,
  target: Field,
  subjects: readonly Subject[],
): Field[] {
  const valueType = describeFieldType(target.type).valueType;
  return subjects.flatMap((subject) =>
    subject.kind === 'field' &&
    subject.field.id !== target.id &&
    describeFieldType(subject.field.type).valueType === valueType &&
    (subject.across === undefined || subject.across.id === clause.entries?.section)
      ? [subject.field]
      : [],
  );
}
