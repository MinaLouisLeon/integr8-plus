import {
  type AiChatMessage,
  type AiGenerateInput,
  type AiGeneration,
  type AiProvider,
  type AiToolRequest,
  arrayAt,
  estimatePromptTokens,
  estimateTokens,
  numberAt,
  postJson,
  stringAt,
} from './provider.js';

/**
 * Anthropic's Messages API (docs/ai §6).
 *
 * Selectable by `AI_PROVIDER=anthropic` with a key and model ids. Tool use
 * arrives as `tool_use` content blocks; a tool's answer goes back as a
 * `tool_result` block in a user turn naming the block's id, every result of
 * one turn in the same user message.
 *
 * No sampling parameter is sent: Claude's 5.x models refuse a non-default
 * `temperature`, and the older ones answer well at the default. Those 5.x
 * models think by default, so a turn that asked for tools is sent back
 * exactly as it came, thinking blocks included, which the API requires; and
 * `AI_ANTHROPIC_EFFORT`, when set, keeps the thinking short enough to leave
 * room for the answer inside `max_tokens`.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = { toolCalling: true };

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      effort?: string | undefined;
    },
  ) {}

  async generate(input: AiGenerateInput): Promise<AiGeneration> {
    const { body } = await postJson(
      'anthropic',
      `${this.options.baseUrl.replace(/\/+$/u, '')}/messages`,
      { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: input.model,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        max_tokens: input.maxOutputTokens,
        ...(this.options.effort === undefined
          ? {}
          : { output_config: { effort: this.options.effort } }),
        ...(input.tools === undefined || input.tools.length === 0
          ? {}
          : {
              tools: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }),
      },
      input.timeoutMs,
    );

    const blocks = arrayAt(body, 'content');
    const text = blocks
      .filter((block) => stringAt(block, 'type') === 'text')
      .map((block) => stringAt(block, 'text') ?? '')
      .join('');
    const toolRequests: AiToolRequest[] = blocks.flatMap((block) => {
      if (stringAt(block, 'type') !== 'tool_use') {
        return [];
      }
      const id = stringAt(block, 'id');
      const name = stringAt(block, 'name');
      if (id === null || name === null) {
        return [];
      }
      return [{ id, name, arguments: (block as { input?: unknown }).input ?? {} }];
    });
    const stop = stringAt(body, 'stop_reason');
    const inputTokens = numberAt(body, 'usage', 'input_tokens');
    const outputTokens = numberAt(body, 'usage', 'output_tokens');
    return {
      text,
      toolRequests,
      // Only a turn that goes on to tool results is ever sent back.
      ...(toolRequests.length === 0 ? {} : { providerContent: blocks }),
      usage:
        inputTokens === null || outputTokens === null
          ? {
              inputTokens: estimatePromptTokens(input),
              outputTokens: estimateTokens(text),
              estimated: true,
            }
          : { inputTokens, outputTokens, estimated: false },
      ...(stringAt(body, 'id') === null ? {} : { providerRequestId: stringAt(body, 'id') ?? '' }),
      finishReason:
        toolRequests.length > 0 || stop === 'tool_use'
          ? 'tool'
          : stop === 'max_tokens'
            ? 'length'
            : stop === 'end_turn' || stop === 'stop_sequence'
              ? 'stop'
              : 'other',
    };
  }
}

/**
 * The conversation in Anthropic's shape. A turn that asked for tools goes back
 * as the provider returned it when we hold that; the tool results that follow
 * it share one user message.
 */
export function toAnthropicMessages(messages: readonly AiChatMessage[]): unknown[] {
  const out: { role: string; content: unknown }[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const result = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
      };
      const last = out.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && isToolResults(last.content)) {
        last.content.push(result);
      } else {
        out.push({ role: 'user', content: [result] });
      }
    } else if (message.role === 'assistant' && Array.isArray(message.providerContent)) {
      out.push({ role: 'assistant', content: message.providerContent });
    } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      out.push({
        role: 'assistant',
        content: [
          ...(message.content === '' ? [] : [{ type: 'text', text: message.content }]),
          ...(message.toolCalls ?? []).map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments ?? {},
          })),
        ],
      });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

function isToolResults(content: unknown[]): boolean {
  return content.every((block) => stringAt(block, 'type') === 'tool_result');
}
