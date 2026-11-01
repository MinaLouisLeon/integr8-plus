import { run } from './cli.js';

// The executable's first line of its own: everything else is importable for tests.
run(process.argv.slice(2));
