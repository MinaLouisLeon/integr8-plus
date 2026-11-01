import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ASSETS } from './assets.js';
import { createFormsServer } from './mcp/server.js';
import { runSetup } from './setup/setup.js';
import { PROGRAM_NAME, VERSION } from './version.js';

/**
 * The program's entry point.
 *
 *   integr8-forms-ai            the installer (what a double-click runs)
 *   integr8-forms-ai setup      the same
 *   integr8-forms-ai serve      the MCP server on stdin/stdout (what AI tools run)
 *   integr8-forms-ai --version
 */

const HELP = `Integr8 Forms for AI ${VERSION}

Usage:
  ${PROGRAM_NAME}            open the installer (choose the AI tools to connect)
  ${PROGRAM_NAME} setup      the same
  ${PROGRAM_NAME} serve      run the MCP server over stdio (AI tools start this)
  ${PROGRAM_NAME} --version  print the version
`;

async function serve(): Promise<void> {
  const server = createFormsServer();
  await server.connect(new StdioServerTransport());
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;
  switch (command) {
    case undefined:
    case 'setup':
      return runSetup({ args: argv.slice(1) });
    case 'serve':
      await serve();
      return -1;
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case '--sea-assets':
      // For the build (scripts/build-sea.mjs): the files the executable must carry.
      process.stdout.write(`${JSON.stringify(ASSETS)}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

/** Runs `main` and exits with its code; -1 means "keep running" (the server). */
export function run(argv: readonly string[]): void {
  main(argv).then(
    (code) => {
      if (code >= 0) {
        process.exitCode = code;
      }
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
