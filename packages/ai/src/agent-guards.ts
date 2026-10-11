// Single responsibility: the two guards that let an `agent()` run with nobody watching — the
// repeated-turn detector and the per-run deadline. Apart from ./agent so the loop reads as a loop.

import { fingerprint } from '@ultimat3/core';
import { AgentDeadlineError, AgentToolLoopError } from './agent-errors';
import type { LlmToolCall, LlmToolResult } from './tools';

/**
 * Consecutive identical turns an agent may take when the declaration omits a number. Three: one
 * repeat is a model re-checking, two is a model that has not read the answer, and nothing a third
 * identical turn returns can make the fourth differ.
 */
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;

/**
 * Called once per tool turn, with what the model asked for and what it was told. Throws
 * `X_AGENT_TOOL_LOOP` on the `limit`-th consecutive turn whose calls AND results are the ones
 * before it. A fingerprint, not the text: one result can be megabytes before it is truncated.
 */
export function toolLoopGuard(
  agent: string,
  limit: number,
): (calls: readonly LlmToolCall[], results: readonly LlmToolResult[]) => void {
  let last: string | undefined;
  let repeats = 0;
  return (calls, results) => {
    const shape = fingerprint({
      calls: calls.map((call) => [call.name, call.input]),
      results: results.map((result) => [result.content, result.isError === true]),
    });
    repeats = shape === last ? repeats + 1 : 1;
    last = shape;
    if (repeats >= limit) {
      throw new AgentToolLoopError({ agent, repeats, tools: calls.map((call) => call.name) });
    }
  };
}

export interface RunDeadline {
  /** The caller's signal and the deadline as one — what every provider call is handed. */
  readonly signal: AbortSignal;
  /** Throws `X_AGENT_DEADLINE` once the deadline has passed. Called before each turn and batch. */
  check(): void;
  /**
   * Await `work`, but no longer than the deadline, and report a failure the deadline caused AS the
   * deadline: the aborted socket surfaces as a transport error, which would otherwise read as the
   * provider's fault. Work that outlives the race is left to finish — a tool has no signal to hear.
   */
  guard<T>(work: Promise<T>): Promise<T>;
}

/** `ms` undefined is no deadline: the caller's signal, and two no-ops. */
export function runDeadline(
  agent: string,
  ms: number | undefined,
  caller: AbortSignal,
): RunDeadline {
  if (ms === undefined) return { signal: caller, check: () => {}, guard: (work) => work };
  const timer = AbortSignal.timeout(ms);
  const expired = (): AgentDeadlineError => new AgentDeadlineError({ agent, deadlineMs: ms });
  // The caller leaving first stays `X_ABORTED`: it is the truer account of why the run stopped.
  const byDeadline = (): boolean => timer.aborted && !caller.aborted;
  return {
    signal: AbortSignal.any([caller, timer]),
    check: () => {
      if (byDeadline()) throw expired();
    },
    guard: async (work) => {
      if (byDeadline()) {
        // Abandoned before it was awaited; its own rejection must not go unhandled.
        work.catch(() => {});
        throw expired();
      }
      let stop = (): void => {};
      const timeout = new Promise<never>((_, reject) => {
        stop = () => reject(expired());
        timer.addEventListener('abort', stop, { once: true });
      });
      try {
        return await Promise.race([work, timeout]);
      } catch (error) {
        work.catch(() => {});
        if (byDeadline()) throw expired();
        throw error;
      } finally {
        timer.removeEventListener('abort', stop);
      }
    },
  };
}
