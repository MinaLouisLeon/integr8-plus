import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyOpenAiFailure, OpenAiProvider } from './openai.js';
import { AiProviderError, type AiGenerateInput } from './provider.js';

/**
 * The OpenAI adapter against recorded response shapes (ADR-0002 D1, D8).
 * No call leaves the process: `fetch` is replaced for each test, and the
 * request it receives is checked as carefully as the answer it returns.
 */

const KEY = 'sk-test-not-a-real-key';

function provider(reasoningEffort?: string) {
  return new OpenAiProvider({
    apiKey: KEY,
    baseUrl: 'https://api.openai.example/v1/',
    reasoningEffort,
  });
}

const base: AiGenerateInput = {
  model: 'gpt-6-luna',
  system: 'You are the Integr8 assistant.',
  messages: [{ role: 'user', content: 'كيف أنشئ أمر عمل؟' }],
  maxOutputTokens: 800,
  timeoutMs: 5_000,
  requestId: 'req-1',
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Captured {
  const captured: Captured = { url: '', headers: {}, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      captured.url = url;
      captured.headers = init.headers as Record<string, string>;
      captured.body = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', ...headers },
        }),
      );
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a plain answer', () => {
  it('sends the model, the system prompt and the bounds OpenAI expects, and reads Arabic back', async () => {
    const captured = respond(200, {
      id: 'chatcmpl-1',
      choices: [
        {
          message: { role: 'assistant', content: 'افتح أوامر العمل ثم اضغط جديد.' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    });
    const answer = await provider().generate(base);

    expect(captured.url).toBe('https://api.openai.example/v1/chat/completions');
    expect(captured.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(captured.body).toMatchObject({
      model: 'gpt-6-luna',
      max_completion_tokens: 800,
      store: false,
      messages: [
        { role: 'system', content: 'You are the Integr8 assistant.' },
        { role: 'user', content: 'كيف أنشئ أمر عمل؟' },
      ],
    });
    // Parameters some OpenAI models refuse are never sent by default.
    expect(captured.body).not.toHaveProperty('max_tokens');
    expect(captured.body).not.toHaveProperty('temperature');
    expect(captured.body).not.toHaveProperty('reasoning_effort');
    expect(captured.body).not.toHaveProperty('tools');

    expect(answer).toEqual({
      text: 'افتح أوامر العمل ثم اضغط جديد.',
      toolRequests: [],
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cachedTokens: 64,
        reasoningTokens: 0,
        estimated: false,
      },
      providerRequestId: 'chatcmpl-1',
      finishReason: 'stop',
    });
  });

  it('sends the reasoning effort only when one is configured', async () => {
    const captured = respond(200, {
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await provider('none').generate(base);
    expect(captured.body.reasoning_effort).toBe('none');
  });

  it('says when the answer was cut off at the output bound', async () => {
    respond(200, {
      choices: [{ message: { content: 'Open Work' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 800 },
    });
    expect((await provider().generate(base)).finishReason).toBe('length');
  });

  it("shows the model's own refusal as its answer, not as an error", async () => {
    respond(200, {
      choices: [
        { message: { content: null, refusal: 'I can’t help with that.' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 6 },
    });
    expect((await provider().generate(base)).text).toBe('I can’t help with that.');
  });

  it('estimates, and says so, when the provider reports no usage', async () => {
    respond(200, { choices: [{ message: { content: 'abcdef' }, finish_reason: 'stop' }] });
    const answer = await provider().generate(base);
    expect(answer.usage.estimated).toBe(true);
    expect(answer.usage.inputTokens).toBeGreaterThan(0);
    expect(answer.usage.outputTokens).toBe(2);
  });

  it('never lets a subset exceed its total', async () => {
    respond(200, {
      choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 99 },
        completion_tokens_details: { reasoning_tokens: 99 },
      },
    });
    const { usage } = await provider().generate(base);
    expect(usage).toMatchObject({ cachedTokens: 10, reasoningTokens: 5 });
  });
});

describe('tools', () => {
  it('offers the tools, carries earlier calls with their exact ids, and reads two new calls', async () => {
    const captured = respond(200, {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_a1',
                type: 'function',
                function: { name: 'get_work_order_summary', arguments: '{"status":"open"}' },
              },
              {
                id: 'call_b2',
                type: 'function',
                function: { name: 'get_customer_summary', arguments: '{"query":"North"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 300, completion_tokens: 40 },
    });

    const answer = await provider().generate({
      ...base,
      messages: [
        { role: 'user', content: 'How many open jobs?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_prev', name: 'get_overdue_work_orders', arguments: {} }],
        },
        { role: 'tool', content: '{"count":2}', toolCallId: 'call_prev' },
      ],
      tools: [
        {
          name: 'get_work_order_summary',
          description: 'Counts work orders.',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });

    expect(captured.body.tool_choice).toBe('auto');
    expect(captured.body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_work_order_summary',
          description: 'Counts work orders.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(captured.body.messages).toEqual([
      { role: 'system', content: base.system },
      { role: 'user', content: 'How many open jobs?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_prev',
            type: 'function',
            function: { name: 'get_overdue_work_orders', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_prev', content: '{"count":2}' },
    ]);

    expect(answer.finishReason).toBe('tool');
    expect(answer.toolRequests).toEqual([
      { id: 'call_a1', name: 'get_work_order_summary', arguments: { status: 'open' } },
      { id: 'call_b2', name: 'get_customer_summary', arguments: { query: 'North' } },
    ]);
  });

  it('turns arguments that are not JSON into null, which every tool schema refuses', async () => {
    respond(200, {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'call_x', type: 'function', function: { name: 'x', arguments: '{oops' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    expect((await provider().generate(base)).toolRequests).toEqual([
      { id: 'call_x', name: 'x', arguments: null },
    ]);
  });
});

describe('failures', () => {
  async function failure(): Promise<AiProviderError> {
    try {
      await provider().generate(base);
    } catch (error) {
      if (error instanceof AiProviderError) {
        return error;
      }
      throw error;
    }
    throw new Error('expected a failure');
  }

  it('tells a spent account apart from a rate limit, by code and never by message', async () => {
    respond(429, {
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    expect(await failure()).toMatchObject({ kind: 'credit_exhausted', provider: 'openai' });

    respond(
      429,
      { error: { message: 'Rate limit reached for requests', type: 'requests', code: null } },
      { 'retry-after': '7' },
    );
    expect(await failure()).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 7 });

    // Words in the message that sound like billing change nothing.
    respond(429, { error: { message: 'insufficient_quota', type: 'requests', code: null } });
    expect((await failure()).kind).toBe('rate_limited');
  });

  it('maps the other refusals, and never carries the key or the body', async () => {
    respond(401, { error: { code: 'invalid_api_key', message: `Incorrect API key ${KEY}` } });
    const refused = await failure();
    expect(refused.kind).toBe('unauthorised');
    expect(refused.message).not.toContain(KEY);

    respond(404, { error: { code: 'model_not_found' } });
    expect((await failure()).kind).toBe('bad_request');

    respond(503, { error: { code: 'server_error' } });
    expect((await failure()).kind).toBe('unavailable');
  });

  it('says it timed out when the deadline passes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    );
    await expect(provider().generate({ ...base, timeoutMs: 10 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('classifies other billing-stop codes the documentation lists', () => {
    for (const code of [
      'credit_balance_exhausted',
      'organization_spend_limit_exceeded',
      'organization_usage_limit_exceeded',
    ]) {
      expect(classifyOpenAiFailure(429, { error: { code } })).toBe('credit_exhausted');
    }
    expect(classifyOpenAiFailure(400, { error: { code: 'invalid_value' } })).toBeUndefined();
  });
});
