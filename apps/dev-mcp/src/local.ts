import { type ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { REPO_ROOT } from './paths.js';
import type { StaffTokens } from './connection.js';

/**
 * Local mode (P38): the API from this repository, started on this laptop
 * against the developer's own database, as the demo seeder does it.
 *
 * `apps/api`'s `dev-mcp-local` script boots the API in its own process,
 * refuses unless APP_ENV is development or test, listens on 127.0.0.1 only,
 * signs a tool account in with a session limited to test companies, and
 * prints the address and tokens on one line. Kept in a child process so this
 * app imports nothing from the API (apps never import from each other), and
 * so local and remote mode share every line of the client.
 */

export interface LocalApi {
  url: string;
  tokens: StaffTokens;
  stop: () => void;
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(args: readonly string[], options: { timeoutMs: number }) {
  const windows = process.platform === 'win32';
  // Through a shell, an argument with spaces is quoted; none may hold a quote.
  const words = windows ? args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)) : args;
  return spawn(pnpm, words, {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    // pnpm.cmd needs a shell on Windows; every argument is fixed here or
    // checked against a strict pattern first (`safeSeedInput`).
    shell: windows,
    windowsHide: true,
    timeout: options.timeoutMs,
  });
}

export async function startLocalApi(): Promise<LocalApi> {
  const child: ChildProcess = run(['--filter', '@integr8/api', '--silent', 'dev-mcp-local'], {
    timeoutMs: 0,
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const line = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (first) => {
      resolve(first);
    });
    child.once('exit', (code) => {
      reject(
        new Error(
          `The local API stopped (exit code ${String(code)}). ${stderr.trim().split('\n').slice(-5).join(' ')}`,
        ),
      );
    });
    child.once('error', reject);
  });
  const started = JSON.parse(line) as StaffTokens & { url: string };
  return {
    url: started.url,
    tokens: {
      accessToken: started.accessToken,
      refreshToken: started.refreshToken,
      sessionExpiresAt: started.sessionExpiresAt,
    },
    stop: () => {
      child.stdin?.end();
      child.kill();
    },
  };
}

export interface SeededCompany {
  name: string;
  slug: string;
  tenantId: string;
  output: string;
}

const EMAIL = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/u;
const NAME = /^[\p{L}\p{N} ().,-]{1,120}$/u;
const SECTION = /^[a-z][a-z-]{1,40}$/u;

/** Refuses anything a shell could read as more than a word. */
export function safeSeedInput(input: {
  ownerEmail: string;
  name?: string;
  only?: readonly string[];
}) {
  if (!EMAIL.test(input.ownerEmail)) {
    throw new Error('ownerEmail must be a plain address, like you@example.com.');
  }
  if (input.name !== undefined && !NAME.test(input.name)) {
    throw new Error('name may hold letters, digits, spaces, brackets, dots, commas and hyphens.');
  }
  for (const key of input.only ?? []) {
    if (!SECTION.test(key)) {
      throw new Error(`"${key}" is not a section key.`);
    }
  }
}

/** Runs the demo seeder: a new test company, its people without sign-in accounts. */
export async function seedTestCompany(input: {
  ownerEmail: string;
  name?: string;
  only?: readonly string[];
}): Promise<SeededCompany> {
  safeSeedInput(input);
  const args = [
    '--filter',
    '@integr8/api',
    '--silent',
    'demo-company',
    '--owner-email',
    input.ownerEmail,
    '--without-sign-in',
    ...(input.name === undefined ? [] : ['--name', input.name]),
    ...(input.only === undefined || input.only.length === 0
      ? []
      : ['--only', input.only.join(',')]),
  ];
  const child = run(args, { timeoutMs: 15 * 60_000 });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => (output += chunk));
  child.stderr?.on('data', (chunk: string) => (output += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  const done = /Done: (.+) \(slug ([a-z0-9-]+), id ([0-9a-f-]{36})\)/u.exec(output);
  if (done === null) {
    throw new Error(
      `The seeder did not finish (exit code ${String(code)}):\n${output.trim().split('\n').slice(-15).join('\n')}`,
    );
  }
  return { name: done[1] ?? '', slug: done[2] ?? '', tenantId: done[3] ?? '', output };
}
