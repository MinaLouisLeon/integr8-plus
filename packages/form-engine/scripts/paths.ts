import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GOLDEN_PATH = join(PACKAGE_ROOT, 'conformance', 'golden.jsonl');
export const GOLDEN_MODULE_PATH = join(PACKAGE_ROOT, 'src', 'conformance', 'golden.ts');
