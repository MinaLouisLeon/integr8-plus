import type { AiGenerateInput, AiGeneration, AiProvider, AiToolRequest } from './provider.js';
import { estimatePromptTokens, estimateTokens } from './provider.js';

/**
 * The deterministic fake (docs/ai §6.1).
 *
 * Needs no account, leaves no building, and answers the same way every time,
 * which is what every test and every laptop wants. Two behaviours:
 *
 * - **Scripted.** A test queues generations with {@link RecordingAiProvider.enqueue};
 *   each call takes the next one. This is how tool calls are exercised without
 *   a model.
 * - **Default.** With nothing queued, it answers from the references the
 *   orchestrator put in the system prompt: it cites the first `[ref:key]`
 *   marker it finds and repeats that article's title, so a citation test can
 *   check the answer names what was retrieved. A message that asks for a tool
 *   by writing `/tool <name> <json>` gets that tool requested, which is how
 *   insight and action tools are driven in tests.
 *
 * Every call is recorded, prompt included, so a test can assert what the
 * model was shown — which is also why this provider is refused in production.
 */

export interface RecordedCall {
  input: AiGenerateInput;
  output: AiGeneration;
}

const REF = /\[ref:([a-z][a-z0-9_]*)\|([^\]]*)\]/u;
const TOOL = /^\/tool\s+([a-z][a-z0-9_]*)\s*(\{[\s\S]*\})?\s*$/u;

export class RecordingAiProvider implements AiProvider {
  readonly id = 'recording' as const;
  readonly capabilities = { toolCalling: true };
  readonly calls: RecordedCall[] = [];
  readonly #queue: Partial<AiGeneration>[] = [];
  #counter = 0;

  enqueue(generation: Partial<AiGeneration>): void {
    this.#queue.push(generation);
  }

  reset(): void {
    this.calls.length = 0;
    this.#queue.length = 0;
  }

  generate(input: AiGenerateInput): Promise<AiGeneration> {
    const scripted = this.#queue.shift();
    const output = scripted === undefined ? this.#answer(input) : this.#complete(scripted, input);
    this.calls.push({ input, output });
    return Promise.resolve(output);
  }

  #complete(scripted: Partial<AiGeneration>, input: AiGenerateInput): AiGeneration {
    const text = scripted.text ?? '';
    return {
      text,
      toolRequests: scripted.toolRequests ?? [],
      usage: scripted.usage ?? {
        inputTokens: estimatePromptTokens(input),
        outputTokens: estimateTokens(text),
        estimated: true,
      },
      finishReason:
        scripted.finishReason ?? ((scripted.toolRequests?.length ?? 0) > 0 ? 'tool' : 'stop'),
    };
  }

  #answer(input: AiGenerateInput): AiGeneration {
    const last = [...input.messages].reverse().find((message) => message.role === 'user');
    const asked = last?.content ?? '';

    // A tool asked for by name, when the member may use it.
    const tool = TOOL.exec(asked.trim());
    if (tool !== null && (input.tools ?? []).some((definition) => definition.name === tool[1])) {
      this.#counter += 1;
      const request: AiToolRequest = {
        id: `call_${String(this.#counter)}`,
        name: tool[1] ?? '',
        arguments: tool[2] === undefined ? {} : (JSON.parse(tool[2]) as unknown),
      };
      return {
        text: '',
        toolRequests: [request],
        usage: { inputTokens: estimatePromptTokens(input), outputTokens: 8, estimated: true },
        finishReason: 'tool',
      };
    }

    // After a tool answered, summarise what it said.
    const toolAnswer = [...input.messages].reverse().find((message) => message.role === 'tool');
    if (
      toolAnswer !== undefined &&
      last !== undefined &&
      input.messages.indexOf(toolAnswer) > input.messages.indexOf(last)
    ) {
      const text = `Here is what I found: ${toolAnswer.content.slice(0, 400)}`;
      return {
        text,
        toolRequests: [],
        usage: {
          inputTokens: estimatePromptTokens(input),
          outputTokens: estimateTokens(text),
          estimated: true,
        },
        finishReason: 'stop',
      };
    }

    const reference = REF.exec(input.system);
    const arabic = /[؀-ۿ]/u.test(asked);
    const text =
      reference === null
        ? arabic
          ? 'ليست لديّ معلومات كافية للإجابة عن هذا من دليل المساعدة. تواصل مع Integr8 للمساعدة.'
          : 'I do not have enough information in the help guide to answer that. Contact Integr8 for help.'
        : arabic
          ? `بحسب «${reference[2] ?? ''}»: ${reference[2] ?? ''}. [cite:${reference[1] ?? ''}]`
          : `According to "${reference[2] ?? ''}": ${reference[2] ?? ''}. [cite:${reference[1] ?? ''}]`;
    return {
      text,
      toolRequests: [],
      usage: {
        inputTokens: estimatePromptTokens(input),
        outputTokens: estimateTokens(text),
        estimated: true,
      },
      finishReason: 'stop',
    };
  }
}
