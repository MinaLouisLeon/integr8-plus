import type { AiLevel } from '@integr8/core';
import { aiProblems, type ApiConfig } from '../config.js';

/**
 * What the server's AI settings allow, read once from the configuration
 * (ADR-0002 D2, D3, D11, D12).
 *
 * The settings never stop the server. A problem that keeps the provider from
 * answering at all leaves only library answers; a level whose model is not set
 * is not served, and a company above it gets the highest level that is. No
 * level ever borrows another level's model. `AI_PROVIDER=none` is no provider
 * by choice: library answers only, and nothing to fix.
 */

export type AiModelLevel = Exclude<AiLevel, 'off'>;

const LEVELS_DOWNWARD: readonly AiModelLevel[] = ['agent', 'insights', 'help'];

/** The model a level runs on, or null when the server has none for it. */
export function modelFor(level: AiModelLevel, config: ApiConfig): string | null {
  if (config.AI_PROVIDER === 'none') {
    return null;
  }
  const configured = {
    help: config.AI_MODEL_HELP,
    insights: config.AI_MODEL_INSIGHTS,
    agent: config.AI_MODEL_AGENT,
  }[level];
  if (configured !== undefined) {
    return configured;
  }
  // The fake provider needs no model names; its own make each level's calls
  // recognisable in a test.
  return config.AI_PROVIDER === 'recording' ? `recording-${level}` : null;
}

export interface AiConfiguration {
  /** False when no model can answer anyone: see `problems`, or `libraryOnly`. */
  ready: boolean;
  /** `AI_PROVIDER=none`: no provider by choice, so every answer is a library one (D12). */
  libraryOnly: boolean;
  /** For the platform screen and the startup log; never for a company. */
  problems: string[];
  models: Record<AiModelLevel, string | null>;
  /** The levels that have a model, highest first. Empty when not ready. */
  servedLevels: AiModelLevel[];
}

export function aiConfiguration(config: ApiConfig): AiConfiguration {
  const problems = aiProblems(config);
  const libraryOnly = config.AI_PROVIDER === 'none';
  const models = {
    help: modelFor('help', config),
    insights: modelFor('insights', config),
    agent: modelFor('agent', config),
  };
  const ready = config.AI_ENABLED && !libraryOnly && problems.length === 0;
  const notes = ready
    ? LEVELS_DOWNWARD.filter((level) => models[level] === null).map(
        (level) => `AI_MODEL_${level.toUpperCase()} is not set: the ${level} level is not served.`,
      )
    : [];
  return {
    ready,
    libraryOnly,
    problems: [...problems, ...notes],
    models,
    servedLevels: ready ? LEVELS_DOWNWARD.filter((level) => models[level] !== null) : [],
  };
}

/**
 * The highest level at or below `level` that this server can run with a
 * model: the level itself when its model is set, else the next one down.
 * `off` when none, which the policy turns into library answers (D11).
 */
export function servableLevel(level: AiLevel, config: ApiConfig): AiLevel {
  if (level === 'off') {
    return 'off';
  }
  const { servedLevels } = aiConfiguration(config);
  const start = LEVELS_DOWNWARD.indexOf(level);
  return (
    LEVELS_DOWNWARD.slice(start).find((candidate) => servedLevels.includes(candidate)) ?? 'off'
  );
}
