import { writeFileSync } from 'node:fs';
import { runConformance } from '../src/conformance/run.js';
import { GOLDEN_PATH } from './paths.js';

/**
 * Regenerates the golden file from Node.
 *
 * Run this only when a change to the engine is *meant* to change what it
 * decides — and read the diff. Every line that moves is a behaviour that moved
 * on every phone, browser and server at once.
 */
writeFileSync(GOLDEN_PATH, `${runConformance()}\n`, 'utf8');
console.log(`Wrote ${GOLDEN_PATH}`);
