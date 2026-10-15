import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';

/**
 * What a model costs, and what a message may cost at worst (docs/ai §4.2 E,
 * §6.4; ADR-0001 D3).
 *
 * Money is integer USD micros and the arithmetic is BigInt, so a price times a
 * token count is never a float rounded somewhere nobody looked. Prices come
 * from `AI_MODEL_PRICES`, versioned by their hash so a call recorded last
 * month still says which table it was costed with; a model with no row is
 * costed at the conservative defaults and marked estimated.
 */

const priceRowSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** USD micros per million input tokens. */
  inputPerMillion: z.number().int().min(0),
  /** USD micros per million output tokens. */
  outputPerMillion: z.number().int().min(0),
});

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** False when the model had no row and the defaults were used. */
  listed: boolean;
  version: string;
}

export class PriceTable {
  readonly #rows: Map<string, z.infer<typeof priceRowSchema>>;
  readonly version: string;
  readonly #defaults: { inputPerMillion: number; outputPerMillion: number };

  constructor(
    config: Pick<
      ApiConfig,
      | 'AI_MODEL_PRICES'
      | 'AI_DEFAULT_PRICE_INPUT_PER_MILLION_MICROUSD'
      | 'AI_DEFAULT_PRICE_OUTPUT_PER_MILLION_MICROUSD'
    >,
  ) {
    const parsed = z.array(priceRowSchema).safeParse(JSON.parse(config.AI_MODEL_PRICES));
    if (!parsed.success) {
      throw new Error(`AI_MODEL_PRICES is not a list of prices: ${parsed.error.message}`);
    }
    this.#rows = new Map(parsed.data.map((row) => [`${row.provider}:${row.model}`, row]));
    this.#defaults = {
      inputPerMillion: config.AI_DEFAULT_PRICE_INPUT_PER_MILLION_MICROUSD,
      outputPerMillion: config.AI_DEFAULT_PRICE_OUTPUT_PER_MILLION_MICROUSD,
    };
    this.version = createHash('sha256')
      .update(
        JSON.stringify([...this.#rows.values()].sort((a, b) => a.model.localeCompare(b.model))),
      )
      .update(JSON.stringify(this.#defaults))
      .digest('hex')
      .slice(0, 12);
  }

  priceFor(provider: string, model: string): ModelPrice {
    const row = this.#rows.get(`${provider}:${model}`);
    return row === undefined
      ? { ...this.#defaults, listed: false, version: this.version }
      : {
          inputPerMillion: row.inputPerMillion,
          outputPerMillion: row.outputPerMillion,
          listed: true,
          version: this.version,
        };
  }
}

/** The cost of a call, rounded up to the micro. */
export function costOf(
  price: Pick<ModelPrice, 'inputPerMillion' | 'outputPerMillion'>,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  const input = BigInt(Math.max(0, tokens.inputTokens)) * BigInt(price.inputPerMillion);
  const output = BigInt(Math.max(0, tokens.outputTokens)) * BigInt(price.outputPerMillion);
  const micros = (input + output + 999_999n) / 1_000_000n;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('cost out of range');
  }
  return Number(micros);
}

/**
 * The most a message may cost: every allowed call at its full input and
 * output bound. Reserved before the first call, settled to the real figure
 * after the last.
 */
export function worstCaseCost(
  price: Pick<ModelPrice, 'inputPerMillion' | 'outputPerMillion'>,
  bounds: { maxInputTokens: number; maxOutputTokens: number; maxProviderCalls: number },
): number {
  return (
    costOf(price, { inputTokens: bounds.maxInputTokens, outputTokens: bounds.maxOutputTokens }) *
    bounds.maxProviderCalls
  );
}

/**
 * A conservative token count for text a provider did not count: one token per
 * three characters, which overestimates English and is about right for Arabic,
 * where a word is often several tokens.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
