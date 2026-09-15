import { GOLDEN } from './golden.js';
import { runConformance } from './run.js';

/**
 * The conformance corpus, for running inside an app (P13).
 *
 * CI proves a second JavaScript engine reproduces Node's decisions byte for
 * byte, but with a Hermes release older than the one a phone ships. Calling
 * this in the app on a device closes that gap: the phone's own engine, the
 * release build's own bytecode, against the same golden file.
 */

export interface ConformanceCheck {
  /** Every case produced exactly the golden line. */
  ok: boolean;
  cases: number;
  /** The cases whose line differed, by name, in corpus order. */
  mismatches: string[];
}

function nameOf(line: string | undefined, index: number): string {
  try {
    const parsed = JSON.parse(line ?? '') as { name?: unknown };
    if (typeof parsed.name === 'string') {
      return parsed.name;
    }
  } catch {
    // A line that is not JSON is named by its position.
  }
  return `line ${String(index + 1)}`;
}

export function checkConformance(): ConformanceCheck {
  const expected = GOLDEN.trimEnd().split('\n');
  const actual = runConformance().split('\n');
  const mismatches: string[] = [];
  const count = Math.max(expected.length, actual.length);
  for (let index = 0; index < count; index += 1) {
    if (expected[index] !== actual[index]) {
      mismatches.push(nameOf(actual[index] ?? expected[index], index));
    }
  }
  return { ok: mismatches.length === 0, cases: actual.length, mismatches };
}

export { runConformance } from './run.js';
