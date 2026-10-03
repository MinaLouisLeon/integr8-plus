import { runConformance } from './run.js';

/**
 * The Hermes command-line runner has no `console` and no module system — only a
 * global `print`. This file is the whole program: bundled into one script by
 * `scripts/run-hermes.ts`, and its single line of output compared with
 * `conformance/golden.jsonl`.
 */
declare const print: (text: string) => void;

print(runConformance());
