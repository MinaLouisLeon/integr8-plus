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
  return parts.join('\n');
}

/** A refusal from packing or reading a package, or any other failure, as text. */
export function formatError(error: unknown): string {
  if (isFormPackageError(error)) {
    const problems = error.problems.map(line).join('\n');
    return `Refused [${error.code}]: ${error.message}${problems === '' ? '' : `\n${problems}`}`;
  }
  return error instanceof Error ? error.message : String(error);
}
