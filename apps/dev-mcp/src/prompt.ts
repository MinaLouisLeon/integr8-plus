import { createInterface } from 'node:readline';

/**
 * Asking in the terminal. A hidden answer (the password, the authenticator
 * code) is read with echo off, so it never appears on screen, in the
 * terminal's scrollback, or anywhere an AI tool could read it.
 */

export async function ask(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve) => {
      lines.question(question, (answer) => {
        resolve(answer.trim());
      });
    });
  } finally {
    lines.close();
  }
}

export async function askHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    throw new Error('Run this in a terminal: the password and code are typed, never passed in.');
  }
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  try {
    return await new Promise((resolve, reject) => {
      let typed = '';
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') {
            input.off('data', onData);
            process.stderr.write('\n');
            resolve(typed);
            return;
          }
          if (char === '\u0003') {
            input.off('data', onData);
            process.stderr.write('\n');
            reject(new Error('Cancelled.'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            typed = typed.slice(0, -1);
          } else {
            typed += char;
          }
        }
      };
      input.on('data', onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}
