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
 * Groq, through its OpenAI-compatible chat completions endpoint (docs/ai §6).
 *
 * The first live provider. Tool calls arrive as `tool_calls` on the assistant
 * message with JSON-encoded arguments; a tool's answer goes back as a `tool`
 * message naming the call. Token counts come from `usage` when present.
 */
export class GroqAiProvider implements AiProvider {
  readonly id = 'groq' as const;
  readonly capabilities = { toolCalling: true };

  constructor(private readonly options: { apiKey: string; baseUrl: string }) {}

  async generate(input: AiGenerateInput): Promise<AiGeneration> {
    const messages: unknown[] = [{ role: 'system', content: input.system }];
    for (const message of input.messages) {
      if (message.role === 'tool') {
        messages.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
        messages.push({
          role: 'assistant',
          content: message.content === '' ? null : message.content,
          tool_calls: (message.toolCalls ?? []).map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }

    const { body } = await postJson(
      'groq',
      `${this.options.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
      { authorization: `Bearer ${this.options.apiKey}` },
      {
        model: input.model,
        messages,
        max_tokens: input.maxOutputTokens,
        temperature: 0.2,
        ...(input.tools === undefined || input.tools.length === 0
          ? {}
          : {
              tools: input.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
              tool_choice: 'auto',
            }),
      },
      input.timeoutMs,
    );

    const text = stringAt(body, 'choices', 0, 'message', 'content') ?? '';
    const toolRequests: AiToolRequest[] = arrayAt(
      body,
      'choices',
      0,
      'message',
      'tool_calls',
    ).flatMap((call) => {
      const name = stringAt(call, 'function', 'name');
      const id = stringAt(call, 'id');
      if (name === null || id === null) {
        return [];
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stringAt(call, 'function', 'arguments') ?? '{}');
      } catch {
        parsed = null;
      }
      return [{ id, name, arguments: parsed }];
    });
    const finish = stringAt(body, 'choices', 0, 'finish_reason');
    const inputTokens = numberAt(body, 'usage', 'prompt_tokens');
    const outputTokens = numberAt(body, 'usage', 'completion_tokens');
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
        toolRequests.length > 0 || finish === 'tool_calls'
          ? 'tool'
          : finish === 'length'
            ? 'length'
            : finish === 'stop'
              ? 'stop'
              : 'other',
    };
  }
}
