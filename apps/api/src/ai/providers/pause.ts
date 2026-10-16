import type { AiProviderId } from '@integr8/core';

/**
 * A pause on calling a provider after it said the account's credit is spent
 * (ADR-0002 D8).
 *
 * Per process, in memory: each API instance learns from its own first refusal
 * and stops asking for the configured time, so a spent account is not hit
 * with every member's next question. Nothing is persisted; a restart asks
 * once more, which is how the pause ends early after the credit is topped up.
 */

const pausedUntil = new Map<AiProviderId, number>();

export function pauseProvider(id: AiProviderId, seconds: number, now = Date.now()): void {
  pausedUntil.set(id, now + seconds * 1000);
}

/** Seconds left on the pause, or null when the provider may be called. */
export function providerPausedFor(id: AiProviderId, now = Date.now()): number | null {
  const until = pausedUntil.get(id);
  if (until === undefined || until <= now) {
    pausedUntil.delete(id);
    return null;
  }
  return Math.ceil((until - now) / 1000);
}

/** For tests, and for nothing else. */
export function clearProviderPauses(): void {
  pausedUntil.clear();
}
