import type { AiGeneration, AiProvider } from './provider.js';
import { AiProviderError } from './provider.js';

/**
 * No AI provider at all (`AI_PROVIDER=none`; ADR-0002 D12).
 *
 * The policy resolution sends every company to the help library on this
 * server, so nothing should ever ask it for a generation. If something does,
 * it fails as an unavailable provider rather than inventing an answer.
 */
export class NoneAiProvider implements AiProvider {
  readonly id = 'none' as const;
  readonly capabilities = { toolCalling: false };

  generate(): Promise<AiGeneration> {
    return Promise.reject(
      new AiProviderError('none', 'unavailable', 'No AI provider is configured on this server.'),
    );
  }
}
