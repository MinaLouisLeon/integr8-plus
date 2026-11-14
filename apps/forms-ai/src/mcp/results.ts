import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { formatError } from './report.js';

/**
 * The shapes every tool answers with: Forms for AI's own tools, its change
 * request tools, and the developer MCP server's tools, which import these
 * through `@integr8/forms-ai/tools` so the three answer the same way.
 */

/** A plain text answer. */
export const text = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
});

/** A text answer the AI tool sees as a failure. */
export const failure = (value: string): CallToolResult => ({
  content: [{ type: 'text', text: value }],
  isError: true,
});

/** Runs a tool's work and turns anything it throws into a readable failure. */
export async function guarded(
  work: () => Promise<CallToolResult> | CallToolResult,
): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error) {
    return failure(formatError(error));
  }
}
