import {
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
 * `tool_result` block in a user turn naming the block's id.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly id = 'anthropic' as const;
  readonly capabilities = { toolCalling: true };

  constructor(private readonly options: { apiKey: string; baseUrl: string }) {}

  async generate(input: AiGenerateInput): Promise<AiGeneration> {
    const messages: unknown[] = [];
    for (const message of input.messages) {
      if (message.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
          ],
        });
      } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
        messages.push({
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
        messages.push({ role: message.role, content: message.content });
      }
    }

    const { body } = await postJson(
      'anthropic',
      `${this.options.baseUrl.replace(/\/+$/u, '')}/messages`,
      { 'x-api-key': this.options.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: input.model,
        system: input.system,
        messages,
        max_tokens: input.maxOutputTokens,
        temperature: 0.2,
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
