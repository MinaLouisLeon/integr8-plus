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
 * Google Gemini, through `generateContent` (docs/ai §6).
 *
 * Selectable by `AI_PROVIDER=gemini` once a key and model ids are set. The
 * free tier's data terms differ from the paid tier's; which data classes it
 * may see is a separate, explicit configuration (`AI_PROVIDER_APPROVED_DATA_CLASSES`).
 */
export class GeminiAiProvider implements AiProvider {
  readonly id = 'gemini' as const;
  readonly capabilities = { toolCalling: true };

  constructor(private readonly options: { apiKey: string; baseUrl: string }) {}

  async generate(input: AiGenerateInput): Promise<AiGeneration> {
    const contents: unknown[] = [];
    for (const message of input.messages) {
      if (message.role === 'tool') {
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: message.toolCallId ?? 'tool',
                response: { result: message.content },
              },
            },
          ],
        });
      } else if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
        contents.push({
          role: 'model',
          parts: (message.toolCalls ?? []).map((call) => ({
            functionCall: { name: call.name, args: call.arguments ?? {} },
          })),
        });
      } else {
        contents.push({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        });
      }
    }

    const { body } = await postJson(
      'gemini',
      `${this.options.baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(input.model)}:generateContent`,
      { 'x-goog-api-key': this.options.apiKey },
      {
        systemInstruction: { parts: [{ text: input.system }] },
        contents,
        generationConfig: { maxOutputTokens: input.maxOutputTokens, temperature: 0.2 },
        ...(input.tools === undefined || input.tools.length === 0
          ? {}
          : {
              tools: [
                {
                  functionDeclarations: input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  })),
                },
              ],
            }),
      },
      input.timeoutMs,
    );

    const parts = arrayAt(body, 'candidates', 0, 'content', 'parts');
    const text = parts
      .map((part) => stringAt(part, 'text'))
      .filter((part): part is string => part !== null)
      .join('');
    const toolRequests: AiToolRequest[] = parts.flatMap((part) => {
      const name = stringAt(part, 'functionCall', 'name');
      if (name === null) {
        return [];
      }
      const args = (part as { functionCall?: { args?: unknown } }).functionCall?.args ?? {};
      // Gemini answers a call by name, so the name doubles as the id.
      return [{ id: name, name, arguments: args }];
    });
    const finish = stringAt(body, 'candidates', 0, 'finishReason');
    const inputTokens = numberAt(body, 'usageMetadata', 'promptTokenCount');
    const outputTokens = numberAt(body, 'usageMetadata', 'candidatesTokenCount');
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
      finishReason:
        toolRequests.length > 0
          ? 'tool'
          : finish === 'MAX_TOKENS'
            ? 'length'
            : finish === 'STOP'
              ? 'stop'
              : 'other',
    };
  }
}
