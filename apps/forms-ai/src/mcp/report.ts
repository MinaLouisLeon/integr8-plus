import {
  type FormPackageCheck,
  isFormPackageError,
  type PackageProblem,
} from '@integr8/form-package';

/**
 * Check results as an AI reads them best: a verdict first, then every problem
 * on its own line with where it is (the package entry and the JSON path), the
 * machine code and the sentence, then the same as JSON for exact matching.
 */

function line(problem: PackageProblem, index: number): string {
  const where = [problem.entry, problem.path].filter((part) => part !== '').join(' › ');
  const elements =
    problem.elements === undefined || problem.elements.length === 0
      ? ''
      : ` (involves: ${problem.elements.join(', ')})`;
  return `${String(index + 1)}. ${where === '' ? '' : `${where} `}[${problem.code}] ${problem.message}${elements}`;
}

const plural = (count: number, word: string) => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

export function formatCheck(check: FormPackageCheck, subject: 'form' | 'package'): string {
  const verdict = check.ok
    ? subject === 'form'
      ? 'OK: the form would publish.'
      : 'OK: the form would publish and every PDF template would save against it.'
    : `NOT OK: ${plural(check.problems.length, 'problem')} would stop ${subject === 'form' ? 'publishing the form' : 'publishing the form or saving a template'}. Fix them and check again.`;
  const parts = [`${verdict} ${plural(check.warnings.length, 'warning')}.`];
  if (check.problems.length > 0) {
    parts.push(`\nProblems (must fix):\n${check.problems.map(line).join('\n')}`);
  }
  if (check.warnings.length > 0) {
    parts.push(
      `\nWarnings (do not block, but fix them — a missing translation leaves the form half-done in that language):\n${check.warnings.map(line).join('\n')}`,
    );
  }
  parts.push(
    `\nAs JSON:\n${JSON.stringify({ ok: check.ok, problems: check.problems, warnings: check.warnings })}`,
  );
  if (check.problems.some(isUnsupported)) {
    parts.push(`\n${UNSUPPORTED_OFFER}`);
  }
  return parts.join('\n');
}

/**
 * A problem that says the format has no such thing (an unknown key, question
 * type or block), as opposed to a mistake in something the format has (P39).
 */
export function isUnsupported(problem: PackageProblem): boolean {
  return /Unrecognized key|Invalid discriminator value|unknown (question |field |block )?type/iu.test(
    problem.message,
  );
}

/** What the AI is told when the check refuses something the format does not have (P39). */
export const UNSUPPORTED_OFFER =
  'Some of these use something the Integr8 Plus format does not have (an unknown key, question type or block). If it is a mistake, fix it from get_format_guide. If the person really needs it, tell them: "The platform cannot do this yet. Shall I record it as a change request?" and, if they agree, ask what should happen, for whom, on which apps and what they do today, then call record_change_request.';

/** A refusal from packing or reading a package, or any other failure, as text. */
export function formatError(error: unknown): string {
  if (isFormPackageError(error)) {
    const problems = error.problems.map(line).join('\n');
    return `Refused [${error.code}]: ${error.message}${problems === '' ? '' : `\n${problems}`}`;
  }
  return error instanceof Error ? error.message : String(error);
}
