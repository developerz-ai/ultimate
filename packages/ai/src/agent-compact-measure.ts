// Single responsibility: what one run has MEASURED about its prompt size — the ratio of the tokens
// a provider reported for a turn to the four-characters-a-token estimate of that request. Dense JSON
// and non-Latin text run at one to two characters a token, so the estimate alone let a run walk past
// the window it was meant to compact before.

import type { TokenUsage } from './provider';

/** One run's measurement. Starts at 1 (the estimate as is); never below it, never signed into a handle. */
export interface PromptMeasure {
  /** Read a turn's reported input against the request that produced it. */
  observe(usage: TokenUsage, estimate: number): void;
  /** The provider refused `estimate` as over `room`: the real figure is at least `room + 1`. */
  overflowed(estimate: number, room: number): void;
  /** `estimate` as the provider would count it, on what this run has seen so far. */
  scale(estimate: number): number;
}

/** The prompt half a provider reports: every input token, read from the cache or not. */
export const reportedInput = (usage: TokenUsage): number =>
  usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;

export function promptMeasure(): PromptMeasure {
  let ratio = 1;
  return {
    observe(usage, estimate) {
      const reported = reportedInput(usage);
      // A provider reporting nothing (a cache hit, a wire with no usage) says nothing: the last
      // measurement stands. Below 1 is ignored — the estimate may stay pessimistic.
      if (reported <= 0 || estimate <= 0) return;
      ratio = Math.max(1, reported / estimate);
    },
    overflowed(estimate, room) {
      if (estimate <= 0) return;
      ratio = Math.max(ratio, (room + 1) / estimate);
    },
    scale: (estimate) => Math.ceil(estimate * ratio),
  };
}
