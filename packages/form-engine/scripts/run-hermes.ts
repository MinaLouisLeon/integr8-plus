import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { GOLDEN_PATH, PACKAGE_ROOT } from './paths.js';

/**
 * Runs the conformance corpus inside Hermes and compares its output with the
 * golden file Node wrote, byte for byte.
 *
 *   HERMES_BIN=/path/to/hermes pnpm --filter @integr8/form-engine conformance:hermes
 *
 * ## The pipeline, and why it has three stages
 *
 * 1. **esbuild** bundles the engine and zod into one script.
 * 2. **Babel, with the mobile app's own preset** — `babel-preset-expo`, resolved
 *    through `apps/mobile`'s `expo` dependency — lowers the syntax. This is the
 *    transform Metro applies to the phone bundle, so the code Hermes runs here
 *    has been through the same hands.
 * 3. **esbuild again**, to inline the `@babel/runtime` helpers Babel imports.
 *    The Hermes command-line runner has no module system.
 *
 * ## Which Hermes, honestly
 *
 * The newest prebuilt Hermes command-line runner is 0.13, published for React
 * Native 0.75. The mobile app runs React Native 0.86, which ships Hermes V1 —
 * newer, and able to run ES6 classes natively where 0.13 cannot parse them. So
 * Babel is told nothing about the engine here and lowers classes, as it would
 * for an older engine.
 *
 * That makes this a real, second JavaScript engine with a different regular
 * expression implementation, number printer, BigInt and string library from
 * V8 — which is what the byte-for-byte comparison needs. It is not the exact
 * engine in the phone. That last step is P13's: the same corpus, inside the app.
 */

const hermes = process.env.HERMES_BIN;
if (hermes === undefined || hermes === '' || !existsSync(hermes)) {
  console.error('Set HERMES_BIN to a Hermes command-line runner. See docs/form-engine/README.md.');
  process.exit(2);
}

const mobileExpo = realpathSync(
  join(PACKAGE_ROOT, '../../apps/mobile/node_modules/expo/package.json'),
);
const fromExpo = createRequire(mobileExpo);
/** The one Babel call this script makes. @babel/core ships no types of its own. */
interface BabelCore {
  transformSync(code: string, options: Record<string, unknown>): { code?: string | null } | null;
}

const babel = fromExpo('@babel/core') as BabelCore;
const expoPreset = fromExpo.resolve('babel-preset-expo');

const workdir = mkdtempSync(join(tmpdir(), 'integr8-hermes-'));
const script = join(workdir, 'conformance.js');

try {
  const bundled = await build({
    entryPoints: [join(PACKAGE_ROOT, 'src/conformance/hermes-entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: ['es2019'],
    mainFields: ['module', 'main'],
    legalComments: 'none',
    logLevel: 'warning',
  });

  const lowered = babel.transformSync(bundled.outputFiles[0]?.text ?? '', {
    filename: 'conformance.js',
    babelrc: false,
    configFile: false,
    sourceType: 'script',
    presets: [expoPreset],
    caller: { name: 'metro', platform: 'android', isServer: false, isDev: false },
  });

  const inlined = await build({
    stdin: {
      contents: lowered?.code ?? '',
      resolveDir: dirname(expoPreset),
      sourcefile: 'lowered.js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: ['es2019'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  writeFileSync(script, inlined.outputFiles[0]?.text ?? '');

  const version =
    execFileSync(hermes, ['-version'], { encoding: 'utf8' })
      .split('\n')
      .find((line) => /Hermes release version/iu.test(line))
      ?.trim() ?? 'unknown version';

  // `-w` silences warnings about globals zod references but never calls here
  // (`File`, `atob`); they are warnings about code paths, not errors.
  const output = execFileSync(hermes, ['-w', script], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  }).replace(/\r\n/gu, '\n');
  const golden = readFileSync(GOLDEN_PATH, 'utf8').replace(/\r\n/gu, '\n');

  if (output === golden) {
    const cases = golden.trimEnd().split('\n').length;
    console.log(
      `${version}: reproduced the golden file byte for byte — ${String(cases)} cases, ${String(Buffer.byteLength(golden))} bytes.`,
    );
    process.exit(0);
  }

  const expected = golden.split('\n');
  const actual = output.split('\n');
  const line = expected.findIndex((text, index) => text !== actual[index]);
  const at = line === -1 ? expected.length : line;
  const a = expected[at] ?? '';
  const b = actual[at] ?? '';
  const column = Math.max(
    0,
    [...a].findIndex((char, index) => char !== b[index]),
  );

  console.error(
    `${version} disagrees with Node on case ${String(at + 1)}, at character ${String(column)}.`,
  );
  console.error(`  node:   …${a.slice(Math.max(0, column - 80), column + 120)}`);
  console.error(`  hermes: …${b.slice(Math.max(0, column - 80), column + 120)}`);
  process.exit(1);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
