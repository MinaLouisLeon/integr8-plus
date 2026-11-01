import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { currentHost, defaultOutputDir, type Host, installDir } from '../host.js';
import { outputFolder, readSettings, writeSettings } from '../settings.js';
import { VERSION } from '../version.js';
import { installedVersion, installSelf } from './install-self.js';
import {
  type Choice,
  LinePrompter,
  plainStyle,
  type Prompter,
  style as colours,
  TerminalPrompter,
} from './prompt.js';
import { systemRunner } from './runner.js';
import { selfTest } from './self-test.js';
import { type ToolAdapter, type ToolContext, type ToolState, TOOLS } from './tools.js';
import { applyUpdate, checkForUpdate, cleanUpAfterUpdate, compareVersions } from './update.js';

/**
 * The installer (decision 15): what a double-click opens. It copies the
 * program to its fixed folder, finds the AI tools on this computer, connects
 * the ones the person ticks, checks that the server answers, and offers a
 * newer release when there is one. English only, like the tool.
 *
 * The same steps run without questions from flags, for scripts and tests:
 *   setup --status | --install all|<ids> | --remove all|<ids> | --self-test
 *         | --output <folder> | --no-update-check
 */

interface Flags {
  status: boolean;
  install: string | undefined;
  remove: string | undefined;
  selfTest: boolean;
  output: string | undefined;
  updateCheck: boolean;
}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = {
    status: false,
    install: undefined,
    remove: undefined,
    selfTest: false,
    output: undefined,
    updateCheck: true,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--status':
        flags.status = true;
        break;
      case '--install':
        flags.install = args[++i] ?? 'all';
        break;
      case '--remove':
        flags.remove = args[++i] ?? 'all';
        break;
      case '--self-test':
        flags.selfTest = true;
        break;
      case '--output':
        flags.output = args[++i];
        break;
      case '--no-update-check':
        flags.updateCheck = false;
        break;
      default:
        throw new Error(`Unknown setup option "${arg ?? ''}".`);
    }
  }
  return flags;
}

type Paint = typeof colours;

function describe(state: ToolState, paint: Paint): string {
  switch (state.kind) {
    case 'not_found':
      return paint.dim('not found on this computer');
    case 'not_installed':
      return 'found, not connected';
    case 'installed':
      return paint.green('connected ✓');
    case 'other_path':
      return paint.yellow(`connected to another copy (${state.command}); install again to fix`);
  }
}

async function statuses(tools: readonly ToolAdapter[], ctx: ToolContext): Promise<ToolState[]> {
  return Promise.all(
    tools.map((tool) => tool.status(ctx).catch((): ToolState => ({ kind: 'not_found' }))),
  );
}

function pick(spec: string, tools: readonly ToolAdapter[]): ToolAdapter[] {
  if (spec === 'all') {
    return [...tools];
  }
  const ids = spec.split(',').map((id) => id.trim());
  const unknown = ids.filter((id) => !tools.some((tool) => tool.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown AI tool "${unknown.join(', ')}". Use: ${tools.map((tool) => tool.id).join(', ')}.`,
    );
  }
  return tools.filter((tool) => ids.includes(tool.id));
}

export interface SetupOptions {
  args: readonly string[];
  host?: Host;
  prompter?: Prompter;
  tools?: readonly ToolAdapter[];
}

class Setup {
  readonly #host: Host;
  readonly #prompter: Prompter;
  readonly #paint: Paint;
  readonly #tools: readonly ToolAdapter[];
  #ctx: ToolContext;
  #executable = false;

  constructor(host: Host, prompter: Prompter, tools: readonly ToolAdapter[]) {
    this.#host = host;
    this.#prompter = prompter;
    this.#paint = prompter.interactive ? colours : plainStyle;
    this.#tools = tools;
    this.#ctx = { host, program: '', runner: systemRunner(host), now: () => new Date() };
  }

  #say(text = ''): void {
    this.#prompter.say(text);
  }

  /** Copies the program into place and works out the path every configuration uses. */
  async prepare(): Promise<void> {
    const paint = this.#paint;
    this.#say(paint.bold(`Integr8 Forms for AI ${VERSION}`));
    this.#say(
      'Lets AI coding tools build Integr8 forms and PDF templates as .integr8form files. Works offline.',
    );
    this.#say();
    let installed = installSelf(this.#host, { replace: false });
    if (installed.executable && !installed.copied && installed.message.includes('different copy')) {
      const theirs = installedVersion(installed.program);
      const newer = theirs !== undefined && compareVersions(theirs, VERSION) > 0;
      const replace = await this.#prompter.confirm(
        newer
          ? `Version ${theirs} is installed, newer than this one (${VERSION}). Replace it with this older version?`
          : `Version ${theirs ?? 'unknown'} is installed. Replace it with this one (${VERSION})?`,
        !newer,
      );
      if (replace) {
        installed = installSelf(this.#host, { replace: true });
      }
    }
    cleanUpAfterUpdate(installed.program);
    this.#executable = installed.executable;
    this.#ctx = { ...this.#ctx, program: installed.program };
    this.#say(installed.message);
  }

  async offerUpdate(): Promise<void> {
    const update = await checkForUpdate(this.#host, VERSION);
    if (update === undefined) {
      return;
    }
    this.#say();
    this.#say(this.#paint.yellow(`A newer version, ${update.version}, is available.`));
    if (!this.#executable) {
      this.#say('Running from source: build the new version instead.');
      return;
    }
    if (!(await this.#prompter.confirm(`Download and install ${update.version} now?`, true))) {
      return;
    }
    try {
      this.#say(`Downloading ${update.asset.name}…`);
      await applyUpdate(update, this.#ctx.program);
      this.#say(
        this.#paint.green(
          `Updated to ${update.version} at ${this.#ctx.program}. AI tools use it from their next start.`,
        ),
      );
      this.#say('Close this window and open the installer again to use the new version here too.');
    } catch (error) {
      this.#say(
        this.#paint.red(
          `The update failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  async showStatus(): Promise<ToolState[]> {
    const states = await statuses(this.#tools, this.#ctx);
    this.#say();
    this.#say(this.#paint.bold('AI tools on this computer'));
    this.#tools.forEach((tool, index) => {
      const state = states[index] ?? { kind: 'not_found' };
      this.#say(`  ${tool.name.padEnd(26)} ${describe(state, this.#paint)}`);
    });
    this.#say(`  Output folder: ${outputFolder(this.#host)}`);
    return states;
  }

  #canChange(): boolean {
    if (!this.#executable) {
      this.#say(
        this.#paint.yellow(
          'This is not the single executable, so AI tools cannot be pointed at it. Build it with `pnpm --filter @integr8/forms-ai sea`.',
        ),
      );
      return false;
    }
    return true;
  }

  /** Connects the tools, then runs the self-test; false when that fails. */
  async install(tools: readonly ToolAdapter[]): Promise<boolean> {
    if (!this.#canChange()) {
      return false;
    }
    for (const tool of tools) {
      const state = await tool.status(this.#ctx);
      if (state.kind === 'not_found') {
        this.#say(`  ${tool.name}: not found, skipped.`);
        continue;
      }
      const outcome = await tool.install(this.#ctx);
      this.#say(
        `  ${tool.name}: ${outcome.ok ? this.#paint.green(outcome.message) : this.#paint.red(outcome.message)}${outcome.backup === undefined ? '' : this.#paint.dim(` (backup: ${outcome.backup})`)}`,
      );
    }
    const ready = await this.runSelfTest();
    this.#say();
    this.#say(
      'Restart each AI tool you connected (or start a new chat), then ask it, for example:',
    );
    this.#say(
      this.#paint.cyan(
        '  "Use integr8-forms to build a boiler service form with a PDF certificate, in English and Arabic."',
      ),
    );
    this.#say(`Finished files are saved in ${outputFolder(this.#host)}.`);
    return ready;
  }

  async remove(tools: readonly ToolAdapter[]): Promise<void> {
    for (const tool of tools) {
      const state = await tool.status(this.#ctx);
      if (state.kind === 'not_found' || state.kind === 'not_installed') {
        continue;
      }
      const outcome = await tool.remove(this.#ctx);
      this.#say(
        `  ${tool.name}: ${outcome.ok ? outcome.message : this.#paint.red(outcome.message)}${outcome.backup === undefined ? '' : this.#paint.dim(` (backup: ${outcome.backup})`)}`,
      );
    }
  }

  async runSelfTest(): Promise<boolean> {
    this.#say();
    this.#say(this.#paint.bold('Self-test'));
    const command = this.#executable ? this.#ctx.program : process.execPath;
    const args = this.#executable
      ? ['serve']
      : [...process.execArgv, process.argv[1] ?? '', 'serve'];
    const result = await selfTest(command, args);
    if (!result.ok) {
      this.#say(
        this.#paint.red(
          `  The server did not start correctly: ${result.error ?? `missing tools ${result.missing.join(', ')}`}`,
        ),
      );
      return false;
    }
    this.#say(
      `  Server ${result.serverVersion ?? '?'} answered with ${String(result.tools.length)} tools: ${result.tools.join(', ')}`,
    );
    const states = await statuses(this.#tools, this.#ctx);
    let any = false;
    this.#tools.forEach((tool, index) => {
      if (states[index]?.kind === 'installed') {
        any = true;
        this.#say(`  ${tool.name}: ${this.#paint.green('Ready ✓')}`);
      } else if (states[index]?.kind === 'other_path') {
        any = true;
        this.#say(
          `  ${tool.name}: ${this.#paint.yellow('connected to another copy — install again')}`,
        );
      }
    });
    if (!any) {
      this.#say('  No AI tool is connected yet.');
    }
    return true;
  }

  async changeOutput(folder?: string): Promise<void> {
    const current = outputFolder(this.#host);
    const chosen =
      folder ?? (await this.#prompter.input('Save .integr8form files in which folder?', current));
    if (chosen === undefined || chosen === current) {
      return;
    }
    if (!isAbsolute(chosen)) {
      this.#say(
        this.#paint.red('Give a full path (for example C:\\Users\\you\\Documents\\Integr8 forms).'),
      );
      return;
    }
    mkdirSync(chosen, { recursive: true });
    writeSettings(this.#host, {
      ...readSettings(this.#host),
      outputFolder: chosen === defaultOutputDir(this.#host) ? null : chosen,
    });
    this.#say(this.#paint.green(`Packages will be saved in ${chosen}.`));
  }

  showVersion(): void {
    this.#say();
    this.#say(`Integr8 Forms for AI ${VERSION}`);
    this.#say(`  Program:       ${this.#ctx.program}`);
    this.#say(`  Install folder: ${installDir(this.#host)}`);
    this.#say(`  Output folder: ${outputFolder(this.#host)}`);
    this.#say(`  Platform:      ${this.#host.platform} ${this.#host.arch}`);
  }

  async chooseTools(title: string, mode: 'install' | 'remove'): Promise<ToolAdapter[] | undefined> {
    const states = await statuses(this.#tools, this.#ctx);
    const choices: Choice[] = this.#tools.map((tool, index) => {
      const state = states[index] ?? { kind: 'not_found' };
      const usable =
        mode === 'install'
          ? state.kind !== 'not_found'
          : state.kind === 'installed' || state.kind === 'other_path';
      return {
        label: tool.name,
        hint: describe(state, this.#paint),
        disabled: !usable,
        checked:
          mode === 'install'
            ? state.kind === 'not_installed' || state.kind === 'other_path'
            : false,
      };
    });
    if (choices.every((choice) => choice.disabled === true)) {
      this.#say(
        mode === 'install'
          ? 'No supported AI tool was found on this computer.'
          : 'Nothing is connected.',
      );
      return undefined;
    }
    const picked = await this.#prompter.checkbox(title, choices);
    return picked?.map((index) => this.#tools[index]).filter((tool) => tool !== undefined);
  }

  async menu(): Promise<void> {
    for (;;) {
      await this.showStatus();
      this.#say();
      const choice = await this.#prompter.select('What would you like to do?', [
        { label: 'Connect to AI tools (install or update)' },
        { label: 'Disconnect from AI tools (remove)' },
        { label: 'Self-test' },
        { label: 'Change output folder' },
        { label: 'Show version and paths' },
        { label: 'Quit' },
      ]);
      switch (choice) {
        case 0: {
          const tools = await this.chooseTools('Connect which AI tools?', 'install');
          if (tools !== undefined && tools.length > 0) {
            await this.install(tools);
          }
          break;
        }
        case 1: {
          const tools = await this.chooseTools('Disconnect which AI tools?', 'remove');
          if (tools !== undefined && tools.length > 0) {
            await this.remove(tools);
          }
          break;
        }
        case 2:
          await this.runSelfTest();
          break;
        case 3:
          await this.changeOutput();
          break;
        case 4:
          this.showVersion();
          break;
        default:
          return;
      }
    }
  }
}

export async function runSetup(options: SetupOptions): Promise<number> {
  const flags = parseFlags(options.args);
  const host = options.host ?? currentHost();
  const prompter =
    options.prompter ??
    (process.stdin.isTTY && process.stdout.isTTY ? new TerminalPrompter() : new LinePrompter());
  const setup = new Setup(host, prompter, options.tools ?? TOOLS);
  const scripted =
    flags.status ||
    flags.install !== undefined ||
    flags.remove !== undefined ||
    flags.selfTest ||
    flags.output !== undefined;
  try {
    await setup.prepare();
    if (flags.updateCheck) {
      await setup.offerUpdate();
    }
    if (!scripted) {
      await setup.menu();
      return 0;
    }
    let ok = true;
    if (flags.output !== undefined) {
      await setup.changeOutput(flags.output);
    }
    if (flags.install !== undefined) {
      ok = await setup.install(pick(flags.install, options.tools ?? TOOLS));
    }
    if (flags.remove !== undefined) {
      await setup.remove(pick(flags.remove, options.tools ?? TOOLS));
    }
    // Installing ends with a self-test of its own.
    if (flags.selfTest && flags.install === undefined) {
      ok = await setup.runSelfTest();
    }
    if (flags.status) {
      await setup.showStatus();
    }
    return ok ? 0 : 1;
  } finally {
    prompter.close();
  }
}
