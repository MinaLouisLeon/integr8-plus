import type { AiProviderId } from '@integr8/core';

/**
 * The one shape every model provider is reduced to (docs/ai §6.1; ADR-0001).
 *
 * Nothing above this file knows a provider's wire format: the orchestrator
 * hands over a system prompt, bounded messages and the tools the member may
 * use, and gets back text, any tool the model asked for, and what it cost in
 * tokens as the provider reported them or as we had to guess.
 */

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** On a `tool` message: which request this answers. */
  toolCallId?: string;
  /** On an `assistant` message that asked for tools: what it asked for. */
  toolCalls?: AiToolRequest[];
}

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the provider expects it. */
  inputSchema: Record<string, unknown>;
}

export interface AiToolRequest {
  id: string;
  name: string;
  /** As the model wrote them; validated by the tool's own schema before use. */
  arguments: unknown;
}

export interface AiGenerateInput {
  model: string;
  system: string;
  messages: AiChatMessage[];
  tools?: AiToolDefinition[];
  maxOutputTokens: number;
  timeoutMs: number;
  requestId: string;
}

export interface AiGeneration {
  text: string;
  toolRequests: AiToolRequest[];
  usage: { inputTokens: number | null; outputTokens: number | null; estimated: boolean };
  providerRequestId?: string;
  finishReason: 'stop' | 'tool' | 'length' | 'other';
}

export interface AiProvider {
  readonly id: AiProviderId;
  readonly capabilities: { toolCalling: boolean };
  generate(input: AiGenerateInput): Promise<AiGeneration>;
}

export type AiProviderFailureKind =
  'rate_limited' | 'timeout' | 'unavailable' | 'bad_request' | 'unauthorised';

/** A provider refused or failed. Never carries the request or the key. */
export class AiProviderError extends Error {
  constructor(
    readonly provider: AiProviderId,
    readonly kind: AiProviderFailureKind,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** A conservative count for text a provider did not count: one token per three characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Tokens of the whole prompt, estimated, for the admission bound and the usage ledger. */
export function estimatePromptTokens(input: Pick<AiGenerateInput, 'system' | 'messages'>): number {
  return (
    estimateTokens(input.system) +
    input.messages.reduce((total, message) => total + estimateTokens(message.content) + 4, 0)
  );
}

/**
 * `fetch` with a deadline, mapped to the failure kinds above. The body is
 * JSON in and JSON out; the caller interprets the document.
 */
export async function postJson(
  provider: AiProviderId,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds =
      retryAfter === null || Number.isNaN(Number(retryAfter)) ? undefined : Number(retryAfter);
    if (response.status === 429) {
      throw new AiProviderError(
        provider,
        'rate_limited',
        'The provider is rate limiting us.',
        retryAfterSeconds ?? 30,
        429,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AiProviderError(
        provider,
        'unauthorised',
        'The provider refused our key.',
        undefined,
        response.status,
      );
    }
    if (response.status >= 500) {
      throw new AiProviderError(
        provider,
        'unavailable',
        `The provider answered ${String(response.status)}.`,
        retryAfterSeconds ?? 30,
        response.status,
      );
    }
    if (response.status >= 400) {
      throw new AiProviderError(
        provider,
        'bad_request',
        `The provider refused the request (${String(response.status)}).`,
        undefined,
        response.status,
      );
    }
    return {
      status: response.status,
      body: parsed,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    };
  } catch (error) {
    if (error instanceof AiProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiProviderError(provider, 'timeout', 'The provider did not answer in time.');
    }
    throw new AiProviderError(provider, 'unavailable', 'The provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

/** A string at a path in an untyped document, or null. */
export function stringAt(value: unknown, ...path: (string | number)[]): string | null {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string | number, unknown>)[step];
  }
  return typeof current === 'string' ? current : null;
}

export function numberAt(value: unknown, ...path: (string | number)[]): number | null {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string | number, unknown>)[step];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : null;
}

export function arrayAt(value: unknown, ...path: (string | number)[]): unknown[] {
  let current: unknown = value;
  for (const step of path) {
    if (current === null || typeof current !== 'object') {
      return [];
    }
    current = (current as Record<string | number, unknown>)[step];
  }
  return Array.isArray(current) ? current : [];
}
