import {
  type AiGenerateInput,
  type AiGeneration,
  type AiProvider,
  type AiProviderFailureKind,
  type AiToolRequest,
  arrayAt,
  estimatePromptTokens,
  estimateTokens,
  numberAt,
  postJson,
  stringAt,
} from './provider.js';

/**
 * OpenAI, through the Chat Completions API (ADR-0002 D1).
 *
 * Stateless: every call carries the system prompt, the conversation so far,
 * each assistant turn's tool calls with their exact ids, and each tool's
 * answer naming the call it answers. The Responses API would also work, but
 * reasoning models expect their reasoning items carried between tool steps,
 * and nothing above this file has a place for them.
 *
 * What differs from the OpenAI-compatible Groq adapter, deliberately:
 *
 * - `max_completion_tokens`, never `max_tokens`, which newer models refuse.
 * - No `temperature`: reasoning models refuse anything but the default.
 * - `reasoning_effort` only when the operator set one, because models that do
 *   not reason refuse the parameter.
 * - `store: false`: nothing a member asked is kept on OpenAI's side for us.
 * - A 429 is read by its structured code: a spent account is
 *   `credit_exhausted`, anything else is a rate limit. The message text is
 *   never matched; it changes and it is not ours to parse.
 * - Usage carries cached input and reasoning output, both subsets of the
 *   totals, recorded but never counted twice.
 */

/** Error codes OpenAI uses for an account with no credit or spend left. */
const BILLING_STOP_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'billing_hard_limit_reached',
  'organization_usage_limit_exceeded',
  'organization_spend_limit_exceeded',
]);

/** Tells a billing stop from a rate limit by the error's code or type. */
export function classifyOpenAiFailure(
  status: number,
  body: unknown,
): AiProviderFailureKind | undefined {
  const code = stringAt(body, 'error', 'code');
  const type = stringAt(body, 'error', 'type');
  if (
    (code !== null && BILLING_STOP_CODES.has(code)) ||
    (type !== null && BILLING_STOP_CODES.has(type))
  ) {
    return 'credit_exhausted';
  }
  return status === 429 ? 'rate_limited' : undefined;
}

export class OpenAiProvider implements AiProvider {
  readonly id = 'openai' as const;
  readonly capabilities = { toolCalling: true };

  constructor(
    private readonly options: {
      apiKey: string;
      baseUrl: string;
      reasoningEffort?: string | undefined;
    },
  ) {}

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

    const tools = input.tools ?? [];
    const { body } = await postJson(
      'openai',
      `${this.options.baseUrl.replace(/\/+$/u, '')}/chat/completions`,
      { authorization: `Bearer ${this.options.apiKey}` },
      {
        model: input.model,
        messages,
        max_completion_tokens: input.maxOutputTokens,
        store: false,
        ...(this.options.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: this.options.reasoningEffort }),
        ...(tools.length === 0
          ? {}
          : {
              tools: tools.map((tool) => ({
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
      classifyOpenAiFailure,
    );

    // A refusal is the model's own answer, shown as such; it is not an error.
    const refusal = stringAt(body, 'choices', 0, 'message', 'refusal');
    const text = stringAt(body, 'choices', 0, 'message', 'content') ?? refusal ?? '';
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
      // Arguments the model wrote that are not JSON reach the tool as null,
      // which its schema refuses: nothing malformed is ever executed.
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
    const cachedTokens = numberAt(body, 'usage', 'prompt_tokens_details', 'cached_tokens');
    const reasoningTokens = numberAt(
      body,
      'usage',
      'completion_tokens_details',
      'reasoning_tokens',
    );
    const requestId = stringAt(body, 'id');

    return {
      text,
      toolRequests,
      usage:
        inputTokens === null || outputTokens === null
          ? {
              inputTokens: estimatePromptTokens(input),
              outputTokens: estimateTokens(text),
              cachedTokens: null,
              reasoningTokens: null,
              estimated: true,
            }
          : {
              inputTokens,
              outputTokens,
              // A subset can never exceed its total, whatever the document says.
              cachedTokens: cachedTokens === null ? null : Math.min(cachedTokens, inputTokens),
              reasoningTokens:
                reasoningTokens === null ? null : Math.min(reasoningTokens, outputTokens),
              estimated: false,
            },
      ...(requestId === null ? {} : { providerRequestId: requestId }),
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
