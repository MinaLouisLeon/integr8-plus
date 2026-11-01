import { emitKeypressEvents } from 'node:readline';
import { createInterface, type Interface } from 'node:readline/promises';

/**
 * The installer's questions, two ways: an arrow-key menu with tick boxes in
 * a terminal (Windows Terminal, cmd.exe, macOS Terminal, Linux terminals all
 * understand the few escape codes it uses), and numbered questions read line
 * by line when there is no terminal (a pipe, a script, a CI log). Hand-rolled
 * on Node's own `readline` rather than a prompt library: four small widgets
 * do not justify a dependency in a program people download and run.
 */

export interface Choice {
  label: string;
  /** Shown dimmed after the label. */
  hint?: string;
  /** Shown but cannot be chosen. */
  disabled?: boolean;
  checked?: boolean;
}

export interface Prompter {
  readonly interactive: boolean;
  say(text: string): void;
  /** The chosen index, or undefined when the person leaves (Esc, q, end of input). */
  select(title: string, choices: readonly Choice[]): Promise<number | undefined>;
  /** The ticked indexes, or undefined when the person leaves. */
  checkbox(title: string, choices: readonly Choice[]): Promise<number[] | undefined>;
  /** A line of text; `fallback` when they just press Enter, undefined at end of input. */
  input(question: string, fallback: string): Promise<string | undefined>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

const ESC = '\u001b[';
export const style = {
  bold: (text: string) => `${ESC}1m${text}${ESC}22m`,
  dim: (text: string) => `${ESC}2m${text}${ESC}22m`,
  green: (text: string) => `${ESC}32m${text}${ESC}39m`,
  yellow: (text: string) => `${ESC}33m${text}${ESC}39m`,
  red: (text: string) => `${ESC}31m${text}${ESC}39m`,
  cyan: (text: string) => `${ESC}36m${text}${ESC}39m`,
};
export const plainStyle: typeof style = {
  bold: (text) => text,
  dim: (text) => text,
  green: (text) => text,
  yellow: (text) => text,
  red: (text) => text,
  cyan: (text) => text,
};

interface Key {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
}

/** The arrow-key prompter for a real terminal. */
export class TerminalPrompter implements Prompter {
  readonly interactive = true;
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
  ) {
    this.#input = input;
    this.#output = output;
    emitKeypressEvents(input);
  }

  say(text: string): void {
    this.#output.write(`${text}\n`);
  }

  /** Draws `render()` and redraws it on every key until `onKey` returns a result. */
  #loop<T>(render: () => string[], onKey: (key: Key) => T | 'redraw' | 'ignore'): Promise<T> {
    return new Promise((resolve) => {
      let drawn = 0;
      const draw = () => {
        if (drawn > 0) {
          this.#output.write(`${ESC}${String(drawn)}A${ESC}0J`);
        }
        const lines = render();
        this.#output.write(`${lines.join('\n')}\n`);
        drawn = lines.length;
      };
      const handler = (_text: string | undefined, key: Key | undefined) => {
        if (key === undefined) {
          return;
        }
        if (key.ctrl === true && key.name === 'c') {
          finish(undefined);
          this.#output.write(`${ESC}?25h`);
          process.exit(130);
        }
        const result = onKey(key);
        if (result === 'ignore') {
          return;
        }
        if (result === 'redraw') {
          draw();
          return;
        }
        draw();
        finish(result);
      };
      const finish = (result: T | undefined) => {
        this.#input.off('keypress', handler);
        this.#input.setRawMode(false);
        this.#input.pause();
        this.#output.write(`${ESC}?25h`);
        if (result !== undefined) {
          resolve(result);
        }
      };
      this.#output.write(`${ESC}?25l`);
      this.#input.setRawMode(true);
      this.#input.resume();
      this.#input.on('keypress', handler);
      draw();
    });
  }

  async select(title: string, choices: readonly Choice[]): Promise<number | undefined> {
    let cursor = Math.max(
      0,
      choices.findIndex((choice) => choice.disabled !== true),
    );
    const move = (step: number) => {
      for (let i = 1; i <= choices.length; i += 1) {
        const next = (cursor + step * i + choices.length * i) % choices.length;
        if (choices[next]?.disabled !== true) {
          cursor = next;
          return;
        }
      }
    };
    const result = await this.#loop<{ index: number | undefined }>(
      () => [
        style.bold(title),
        ...choices.map((choice, index) => {
          const pointer = index === cursor ? style.cyan('❯') : ' ';
          const label = choice.disabled === true ? style.dim(choice.label) : choice.label;
          return `${pointer} ${label}${choice.hint === undefined ? '' : ` ${style.dim(choice.hint)}`}`;
        }),
        style.dim('↑/↓ to move, Enter to choose, Esc to go back'),
      ],
      (key) => {
        if (key.name === 'up' || key.name === 'k') {
          move(-1);
          return 'redraw';
        }
        if (key.name === 'down' || key.name === 'j') {
          move(1);
          return 'redraw';
        }
        if (key.name === 'return' || key.name === 'enter') {
          return { index: cursor };
        }
        if (key.name === 'escape' || key.name === 'q') {
          return { index: undefined };
        }
        return 'ignore';
      },
    );
    return result.index;
  }

  async checkbox(title: string, choices: readonly Choice[]): Promise<number[] | undefined> {
    const ticked = choices.map((choice) => choice.checked === true && choice.disabled !== true);
    let cursor = Math.max(
      0,
      choices.findIndex((choice) => choice.disabled !== true),
    );
    const result = await this.#loop<{ picked: number[] | undefined }>(
      () => [
        style.bold(title),
        ...choices.map((choice, index) => {
          const pointer = index === cursor ? style.cyan('❯') : ' ';
          const box =
            choice.disabled === true
              ? style.dim('[-]')
              : ticked[index] === true
                ? style.green('[x]')
                : '[ ]';
          const label = choice.disabled === true ? style.dim(choice.label) : choice.label;
          return `${pointer} ${box} ${label}${choice.hint === undefined ? '' : ` ${style.dim(choice.hint)}`}`;
        }),
        style.dim('↑/↓ to move, Space to tick, a to tick all, Enter to confirm, Esc to go back'),
      ],
      (key) => {
        if (key.name === 'up' || key.name === 'k') {
          cursor = (cursor - 1 + choices.length) % choices.length;
          return 'redraw';
        }
        if (key.name === 'down' || key.name === 'j') {
          cursor = (cursor + 1) % choices.length;
          return 'redraw';
        }
        if (key.name === 'space') {
          if (choices[cursor]?.disabled !== true) {
            ticked[cursor] = ticked[cursor] !== true;
          }
          return 'redraw';
        }
        if (key.name === 'a') {
          const all = choices.every(
            (choice, index) => choice.disabled === true || ticked[index] === true,
          );
          choices.forEach((choice, index) => {
            ticked[index] = choice.disabled !== true && !all;
          });
          return 'redraw';
        }
        if (key.name === 'return' || key.name === 'enter') {
          return { picked: ticked.flatMap((on, index) => (on ? [index] : [])) };
        }
        if (key.name === 'escape' || key.name === 'q') {
          return { picked: undefined };
        }
        return 'ignore';
      },
    );
    return result.picked;
  }

  async input(question: string, fallback: string): Promise<string | undefined> {
    const lines = createInterface({ input: this.#input, output: this.#output, terminal: true });
    try {
      const answer = await lines.question(`${question} ${style.dim(`[${fallback}]`)} `);
      return answer.trim() === '' ? fallback : answer.trim();
    } finally {
      lines.close();
    }
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const answer = await this.input(`${question} (y/n)`, fallback ? 'y' : 'n');
    return /^y(es)?$/iu.test(answer ?? '');
  }

  close(): void {
    this.#input.pause();
  }
}

/** Numbered questions, one line of input each, for when there is no terminal. */
export class LinePrompter implements Prompter {
  readonly interactive = false;
  readonly #lines: Interface;
  readonly #output: NodeJS.WritableStream;
  readonly #queue: string[] = [];
  readonly #waiting: ((line: string | undefined) => void)[] = [];
  #ended = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    output: NodeJS.WritableStream = process.stdout,
  ) {
    this.#output = output;
    this.#lines = createInterface({ input, terminal: false });
    this.#lines.on('line', (line) => {
      const waiter = this.#waiting.shift();
      if (waiter === undefined) {
        this.#queue.push(line);
      } else {
        waiter(line);
      }
    });
    this.#lines.on('close', () => {
      this.#ended = true;
      for (const waiter of this.#waiting.splice(0)) {
        waiter(undefined);
      }
    });
  }

  #read(prompt: string): Promise<string | undefined> {
    this.#output.write(prompt);
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      this.#output.write(`${queued}\n`);
      return Promise.resolve(queued);
    }
    if (this.#ended) {
      this.#output.write('\n');
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  say(text: string): void {
    this.#output.write(`${text}\n`);
  }

  async select(title: string, choices: readonly Choice[]): Promise<number | undefined> {
    this.say(title);
    choices.forEach((choice, index) => {
      this.say(
        `  ${String(index + 1)}. ${choice.label}${choice.hint === undefined ? '' : ` ${choice.hint}`}${choice.disabled === true ? ' (not available)' : ''}`,
      );
    });
    for (;;) {
      const answer = await this.#read('Number (empty to go back): ');
      if (answer === undefined || answer.trim() === '') {
        return undefined;
      }
      const index = Number.parseInt(answer, 10) - 1;
      if (choices[index] !== undefined && choices[index].disabled !== true) {
        return index;
      }
      this.say('That is not one of the numbers above.');
    }
  }

  async checkbox(title: string, choices: readonly Choice[]): Promise<number[] | undefined> {
    this.say(title);
    choices.forEach((choice, index) => {
      this.say(
        `  ${String(index + 1)}. ${choice.label}${choice.hint === undefined ? '' : ` ${choice.hint}`}${choice.disabled === true ? ' (not available)' : ''}`,
      );
    });
    const suggested = choices.flatMap((choice, index) =>
      choice.checked === true && choice.disabled !== true ? [String(index + 1)] : [],
    );
    for (;;) {
      const answer = await this.#read(
        `Numbers separated by commas, "all", or empty for ${suggested.length === 0 ? 'none' : suggested.join(',')}: `,
      );
      if (answer === undefined) {
        return undefined;
      }
      const text = answer.trim().toLowerCase();
      if (text === '') {
        return suggested.map((value) => Number(value) - 1);
      }
      if (text === 'all') {
        return choices.flatMap((choice, index) => (choice.disabled === true ? [] : [index]));
      }
      const picked = text.split(/[\s,]+/u).map((part) => Number.parseInt(part, 10) - 1);
      if (
        picked.every((index) => choices[index] !== undefined && choices[index].disabled !== true)
      ) {
        return [...new Set(picked)];
      }
      this.say('Use the numbers of available entries above.');
    }
  }

  async input(question: string, fallback: string): Promise<string | undefined> {
    const answer = await this.#read(`${question} [${fallback}] `);
    if (answer === undefined) {
      return undefined;
    }
    return answer.trim() === '' ? fallback : answer.trim();
  }

  async confirm(question: string, fallback: boolean): Promise<boolean> {
    const answer = await this.input(`${question} (y/n)`, fallback ? 'y' : 'n');
    return /^y(es)?$/iu.test(answer ?? '');
  }

  close(): void {
    this.#lines.close();
  }
}
