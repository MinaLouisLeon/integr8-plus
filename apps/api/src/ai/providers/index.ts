import { AI_DATA_CLASSES, type AiDataClass, type AiProviderId } from '@integr8/core';
import type { ApiConfig } from '../../config.js';
import type { AiProvider } from './provider.js';
import { AnthropicAiProvider } from './anthropic.js';
import { GeminiAiProvider } from './gemini.js';
import { GroqAiProvider } from './groq.js';
import { NoneAiProvider } from './none.js';
import { OpenAiProvider } from './openai.js';
import { RecordingAiProvider } from './recording.js';

/**
 * Which providers this deployment can reach, and what each may be shown
 * (docs/ai §6.3; ADR-0001 D5). The adapters themselves arrive with the chat
 * (Phase C); what the dashboard needs first is the configuration facts, with
 * no key or part of one in any answer.
 */

/**
 * True when the provider could be called: the fake always, a live one with
 * its key, `none` never.
 */
export function providerStatus(id: AiProviderId, config: ApiConfig): boolean {
  switch (id) {
    case 'none':
      return false;
    case 'recording':
      return true;
    case 'groq':
      return (config.AI_GROQ_API_KEY ?? '') !== '';
    case 'gemini':
      return (config.AI_GEMINI_API_KEY ?? '') !== '';
    case 'anthropic':
      return (config.AI_ANTHROPIC_API_KEY ?? '') !== '';
    case 'openai':
      return (config.AI_OPENAI_API_KEY ?? '') !== '';
  }
}

/**
 * The data classes a provider is approved for, from
 * `AI_PROVIDER_APPROVED_DATA_CLASSES`: `groq:company_operational;company_financial,gemini:…`.
 * Public help needs no approval; the fake provider leaves no building and is
 * approved for everything.
 */
export function approvedDataClasses(id: AiProviderId, config: ApiConfig): AiDataClass[] {
  if (id === 'recording') {
    return [...AI_DATA_CLASSES];
  }
  const approved = new Set<AiDataClass>(['public_help']);
  for (const entry of config.AI_PROVIDER_APPROVED_DATA_CLASSES.split(',')) {
    const [provider, classes] = entry.split(':').map((part) => part.trim());
    if (provider !== id || classes === undefined) {
      continue;
    }
    for (const candidate of classes.split(';').map((part) => part.trim())) {
      if ((AI_DATA_CLASSES as readonly string[]).includes(candidate)) {
        approved.add(candidate as AiDataClass);
      }
    }
  }
  return AI_DATA_CLASSES.filter((dataClass) => approved.has(dataClass));
}

/**
 * The provider `AI_PROVIDER` names, built once at composition. Only that one
 * is built, so no other provider can be called by mistake or by fallback.
 */
export function buildAiProvider(config: ApiConfig): AiProvider {
  switch (config.AI_PROVIDER) {
    case 'none':
      return new NoneAiProvider();
    case 'recording':
      return new RecordingAiProvider();
    case 'groq':
      return new GroqAiProvider({
        apiKey: config.AI_GROQ_API_KEY ?? '',
        baseUrl: config.AI_GROQ_BASE_URL,
      });
    case 'gemini':
      return new GeminiAiProvider({
        apiKey: config.AI_GEMINI_API_KEY ?? '',
        baseUrl: config.AI_GEMINI_BASE_URL,
      });
    case 'anthropic':
      return new AnthropicAiProvider({
        apiKey: config.AI_ANTHROPIC_API_KEY ?? '',
        baseUrl: config.AI_ANTHROPIC_BASE_URL,
      });
    case 'openai':
      return new OpenAiProvider({
        apiKey: config.AI_OPENAI_API_KEY ?? '',
        baseUrl: config.AI_OPENAI_BASE_URL,
        reasoningEffort: config.AI_OPENAI_REASONING_EFFORT,
      });
  }
}

export { RecordingAiProvider } from './recording.js';
export {
  AiProviderError,
  type AiProvider,
  type AiGenerateInput,
  type AiGeneration,
  type AiChatMessage,
  type AiToolDefinition,
  type AiToolRequest,
} from './provider.js';
