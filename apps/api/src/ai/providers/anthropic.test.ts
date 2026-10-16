import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAiProvider, toAnthropicMessages } from './anthropic.js';
import type { AiChatMessage, AiGenerateInput } from './provider.js';

/**
 * The Anthropic adapter against recorded response shapes. No call leaves the
 * process: `fetch` is replaced for each test, and the request it receives is
 * checked as carefully as the answer it returns.
 *
 * What matters for Claude's 5.x models: no sampling parameter (they refuse a
 * non-default `temperature`), effort only when configured, and a turn that
 * asked for tools sent back exactly as it came, thinking blocks included.
 */

const KEY = 'sk-ant-test-not-a-real-key';

function provider(effort?: string) {
  return new AnthropicAiProvider({
    apiKey: KEY,
    baseUrl: 'https://api.anthropic.example/v1/',
    effort,
  });
}

const base: AiGenerateInput = {
  model: 'claude-haiku-5-5',
  system: 'You are the Integr8 assistant.',
  messages: [{ role: 'user', content: 'How do I create a work order?' }],
  maxOutputTokens: 1500,
  timeoutMs: 5_000,
  requestId: 'req-1',
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function respond(status: number, body: unknown): Captured {
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
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A 5.x answer: an empty thinking block (display omitted) before the text. */
const THINKING = { type: 'thinking', thinking: '', signature: 'sig-abc' };

describe('a plain answer', () => {
  it('sends no temperature and no effort unless configured, and reads the text past the thinking', async () => {
    const captured = respond(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [THINKING, { type: 'text', text: 'Open Work orders and choose New.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    const answer = await provider().generate(base);

    expect(captured.url).toBe('https://api.anthropic.example/v1/messages');
    expect(captured.headers['x-api-key']).toBe(KEY);
    expect(captured.headers['anthropic-version']).toBe('2023-06-01');
    expect(captured.body).toMatchObject({
      model: 'claude-haiku-5-5',
      system: 'You are the Integr8 assistant.',
      max_tokens: 1500,
    });
    expect(captured.body).not.toHaveProperty('temperature');
    expect(captured.body).not.toHaveProperty('top_p');
    expect(captured.body).not.toHaveProperty('output_config');
    expect(captured.body).not.toHaveProperty('thinking');
    expect(answer).toMatchObject({
      text: 'Open Work orders and choose New.',
      toolRequests: [],
      finishReason: 'stop',
      usage: { inputTokens: 120, outputTokens: 30, estimated: false },
      providerRequestId: 'msg_1',
    });
    // A finished answer is never sent back, so nothing is carried for it.
    expect(answer.providerContent).toBeUndefined();
  });

  it('sends the configured effort inside output_config', async () => {
    const captured = respond(200, {
      content: [{ type: 'text', text: 'Yes.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    await provider('low').generate(base);
    expect(captured.body.output_config).toEqual({ effort: 'low' });
  });

  it('reads a refusal as a finish of its own, with whatever text came', async () => {
    respond(200, {
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
      usage: { input_tokens: 10, output_tokens: 0 },
    });
    expect(await provider().generate(base)).toMatchObject({ text: '', finishReason: 'other' });
  });
});

describe('a turn that asks for a tool', () => {
  const asked = {
    id: 'msg_2',
    content: [
      THINKING,
      { type: 'text', text: 'Let me count them.' },
      { type: 'tool_use', id: 'toolu_1', name: 'count_work_orders', input: { status: 'open' } },
      { type: 'tool_use', id: 'toolu_2', name: 'count_customers', input: {} },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 200, output_tokens: 40 },
  };

  it('returns the tool requests and the turn as it came, thinking included', async () => {
    respond(200, asked);
    const answer = await provider().generate(base);
    expect(answer.finishReason).toBe('tool');
    expect(answer.toolRequests).toEqual([
      { id: 'toolu_1', name: 'count_work_orders', arguments: { status: 'open' } },
      { id: 'toolu_2', name: 'count_customers', arguments: {} },
    ]);
    expect(answer.providerContent).toEqual(asked.content);
  });

  it('sends that turn back unchanged, with both results in one user message', async () => {
    respond(200, asked);
    const first = await provider().generate(base);
    const history: AiChatMessage[] = [
      ...base.messages,
      {
        role: 'assistant',
        content: first.text,
        toolCalls: first.toolRequests,
        providerContent: first.providerContent,
      },
      { role: 'tool', toolCallId: 'toolu_1', content: '{"count":4}' },
      { role: 'tool', toolCallId: 'toolu_2', content: '{"count":9}' },
    ];
    const captured = respond(200, {
      content: [{ type: 'text', text: 'You have 4 open work orders.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 260, output_tokens: 12 },
    });
    await provider().generate({ ...base, messages: history });

    expect(captured.body.messages).toEqual([
      { role: 'user', content: 'How do I create a work order?' },
      { role: 'assistant', content: asked.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"count":4}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '{"count":9}' },
        ],
      },
    ]);
  });
});

describe('a conversation from before this adapter carried turns', () => {
  it('rebuilds a tool turn from its text and calls when nothing was carried', () => {
    expect(
      toAnthropicMessages([
        { role: 'user', content: 'Count them.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_9', name: 'count_customers', arguments: {} }],
        },
        { role: 'tool', toolCallId: 'toolu_9', content: '{"count":1}' },
      ]),
    ).toEqual([
      { role: 'user', content: 'Count them.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_9', name: 'count_customers', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{"count":1}' }],
      },
    ]);
  });
});
