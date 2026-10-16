import type { AiLevel } from '@integr8/core';
import { aiProblems, type ApiConfig } from '../config.js';

/**
 * What the server's AI settings allow, read once from the configuration
 * (ADR-0002 D2, D3).
 *
 * The settings never stop the server. A problem that keeps the provider from
 * answering at all turns the assistant off; a level whose model is not set is
 * not served, and a company above it gets the highest level that is. No level
 * ever borrows another level's model.
 */

export type AiModelLevel = Exclude<AiLevel, 'off'>;

const LEVELS_DOWNWARD: readonly AiModelLevel[] = ['agent', 'insights', 'help'];

/** The model a level runs on, or null when the server has none for it. */
export function modelFor(level: AiModelLevel, config: ApiConfig): string | null {
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
  /** False when the assistant cannot answer anyone: see `problems`. */
  ready: boolean;
  /** For the platform screen and the startup log; never for a company. */
  problems: string[];
  models: Record<AiModelLevel, string | null>;
  /** The levels that have a model, highest first. Empty when not ready. */
  servedLevels: AiModelLevel[];
}

export function aiConfiguration(config: ApiConfig): AiConfiguration {
  const problems = aiProblems(config);
  const models = {
    help: modelFor('help', config),
    insights: modelFor('insights', config),
    agent: modelFor('agent', config),
  };
  const ready = config.AI_ENABLED && problems.length === 0;
  const notes =
    config.AI_ENABLED && ready
      ? LEVELS_DOWNWARD.filter((level) => models[level] === null).map(
          (level) =>
            `AI_MODEL_${level.toUpperCase()} is not set: the ${level} level is not served.`,
        )
      : [];
  return {
    ready,
    problems: [...problems, ...notes],
    models,
    servedLevels: ready ? LEVELS_DOWNWARD.filter((level) => models[level] !== null) : [],
  };
}

/**
 * The highest level at or below `level` that this server can run: the level
 * itself when its model is set, else the next one down. `off` when none.
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
