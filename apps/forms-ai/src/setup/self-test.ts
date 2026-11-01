import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VERSION } from '../version.js';

/**
 * Starts the server exactly as an AI tool does (`<program> serve` over
 * stdio), asks it for its tools over MCP and calls the cheapest one. If this
 * passes, every AI tool configured with the same command will find it.
 */

export const EXPECTED_TOOLS = [
  'get_format_guide',
  'list_examples',
  'get_example',
  'new_picture_ids',
  'check_form',
  'check_package',
  'preview_pdf',
  'save_package',
  'open_package',
] as const;

export interface SelfTestResult {
  ok: boolean;
  serverVersion: string | undefined;
  tools: string[];
  missing: string[];
  error?: string;
}

export async function selfTest(
  command: string,
  args: readonly string[] = ['serve'],
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<SelfTestResult> {
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    stderr: 'pipe',
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const client = new Client({ name: 'integr8-forms-self-test', version: VERSION });
  const timeout = options.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await client.connect(transport);
      const listed = await client.listTools();
      const tools = listed.tools.map((tool) => tool.name);
      const guide = await client.callTool({
        name: 'get_format_guide',
        arguments: { section: 'limits' },
      });
      const missing = EXPECTED_TOOLS.filter((name) => !tools.includes(name));
      return {
        ok: missing.length === 0 && guide.isError !== true,
        serverVersion: client.getServerVersion()?.version,
        tools,
        missing,
      };
    })();
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`The server did not answer within ${String(timeout / 1000)} seconds.`));
        }, timeout);
      }),
    ]);
  } catch (error) {
    return {
      ok: false,
      serverVersion: undefined,
      tools: [],
      missing: [...EXPECTED_TOOLS],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}
