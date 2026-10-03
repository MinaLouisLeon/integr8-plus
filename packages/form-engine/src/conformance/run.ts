import { canonicalJson } from '../canonical.js';
import { compileDefinition } from '../compile.js';
import { createFormState, toSubmission, transition, viewForm } from '../state.js';
import { validateSubmission } from '../validation.js';
import { migrateAnswers } from '../versioning.js';
import { CASES, type ConformanceCase } from './cases.js';
import { snapshotView } from './snapshot.js';

/**
 * Runs the corpus and returns one canonical JSON line per case.
 *
 * No I/O, no globals: the Node test and the Hermes bundle call exactly this and
 * compare what it returns with the committed golden file.
 */
export function runConformance(cases: readonly ConformanceCase[] = CASES): string {
  return cases.map((testCase) => canonicalJson(runCase(testCase))).join('\n');
}

function runCase(testCase: ConformanceCase): Record<string, unknown> {
  const compiled = compileDefinition(testCase.definition);
  if (!compiled.ok) {
    return { name: testCase.name, compiled: false, issues: compiled.issues };
  }

  const form = compiled.form;
  const context = testCase.context ?? {};
  let state = createFormState(form);

  const steps: unknown[] = [
    { event: 'start', view: snapshotView(form, viewForm(form, state, context)) },
  ];
  for (const event of testCase.steps ?? []) {
    const result = transition(form, state, event, context);
    state = result.state;
    steps.push({
      event,
      accepted: result.accepted,
      reason: result.accepted ? undefined : result.reason,
      view: snapshotView(form, viewForm(form, state, context)),
    });
  }

  const record: Record<string, unknown> = {
    name: testCase.name,
    compiled: true,
    evaluationOrder: form.evaluationOrder,
    steps,
    finalSubmission: toSubmission(form, state, context),
  };

  if (testCase.submission !== undefined) {
    record.serverCheck = validateSubmission(form, testCase.submission, context);
  }

  if (testCase.migrateTo !== undefined) {
    const next = compileDefinition(testCase.migrateTo);
    record.migration = next.ok
      ? migrateAnswers(form, next.form, state.answers)
      : { issues: next.issues };
  }

  return record;
}
