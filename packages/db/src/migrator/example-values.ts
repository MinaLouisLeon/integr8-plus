import { exampleValueProblems } from '@integr8/core';

/** The commands that write to the database, as the `bootstrap` and `migrate` services run them. */
const WRITING_COMMANDS = new Set(['bootstrap', 'deploy', 'up', 'down']);

export interface ExampleValueVerdict {
  /** Lines to print before stopping; empty means go ahead. */
  refuse: string[];
  /** Lines to print and carry on. */
  warn: string[];
}

/**
 * Whether a database command may run with the settings it was given.
 *
 * The same rule the API and the worker apply at start-up (`exampleValueProblems`
 * in `@integr8/core`): in production, a `change-me` password from
 * `deploy/.env.example`, an example address, or a database password shorter
 * than sixteen characters stops it, naming the setting and never the value.
 * Here it matters most, because `bootstrap` is what turns those passwords into
 * the database roles. Staging says so and carries on, as the API does.
 * Reading commands (`status`, `verify`) always run: they are how somebody finds
 * out what state a refused deployment is in.
 */
export function exampleValueVerdict(env: NodeJS.ProcessEnv, command: string): ExampleValueVerdict {
  if (!WRITING_COMMANDS.has(command)) {
    return { refuse: [], warn: [] };
  }
  const problems = exampleValueProblems(env);
  if (problems.length === 0) {
    return { refuse: [], warn: [] };
  }
  if (env.APP_ENV === 'production') {
    return {
      refuse: [
        `Refusing to run "${command}" in production:`,
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'Fix deploy/.env (sh deploy/vps/check-env.sh lists what is left) and start again.',
      ],
      warn: [],
    };
  }
  if (env.APP_ENV === 'staging') {
    return {
      refuse: [],
      warn: problems.map((problem) => `Production would refuse to run "${command}": ${problem}`),
    };
  }
  return { refuse: [], warn: [] };
}
