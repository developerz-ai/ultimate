// Single responsibility: the two guards that let an `agent()` run with nobody watching — the
// repeated-turn detector and the per-run deadline. Apart from ./agent so the loop reads as a loop.

import { fingerprint, withChildContext } from '@ultimat3/core';
import { AgentDeadlineError, AgentToolLoopError } from './agent-errors';
import type { LlmToolCall, LlmToolResult } from './tools';

/**
 * Consecutive identical turns an agent may take when the declaration omits a number. Three: one
 * repeat is a model re-checking, two is a model that has not read the answer, and nothing a third
 * identical turn returns can make the fourth differ.
 */
export const DEFAULT_MAX_REPEATED_TOOL_CALLS = 3;

/** The longest cycle looked for: A,B,C,A,B,C. A longer one is `maxTurns`' to stop. */
const MAX_CYCLE = 3;

/**
 * Called once per TOOL turn, with what the model asked for and what it was told. Throws
 * `X_AGENT_TOOL_LOOP` when the most recent tool turns are one cycle of up to `MAX_CYCLE` turns
 * gone round `limit` times — the same turn `limit` times, or A,B,A,B… — where "the same" is the
 * calls, their arguments, the results AND whether each failed. A changed result is progress and
 * breaks the cycle. A fingerprint, not the text: one result can be megabytes before truncation.
 *
 * A repair turn (a wrong-shaped answer; no tool ran) is not a tool turn, so it neither counts nor
 * resets: the correction is about the answer's shape and tells the model nothing new about a tool.
 */
export function toolLoopGuard(
  agent: string,
  limit: number,
): (calls: readonly LlmToolCall[], results: readonly LlmToolResult[]) => void {
  const window = MAX_CYCLE * limit;
  let recent: readonly { readonly shape: string; readonly tools: readonly string[] }[] = [];
  return (calls, results) => {
    const shape = fingerprint({
      calls: calls.map((call) => [call.name, call.input]),
      results: results.map((result) => [result.content, result.isError === true]),
    });
    recent = [...recent, { shape, tools: calls.map((call) => call.name) }].slice(-window);
    for (let cycle = 1; cycle <= MAX_CYCLE; cycle += 1) {
      const laps = recent.slice(-cycle * limit);
      if (laps.length < cycle * limit) break;
      const repeats = (turn: (typeof laps)[number], index: number): boolean =>
        index < cycle || isSameTurn(turn.shape, laps[index - cycle]?.shape);
      if (!laps.every(repeats)) continue;
      const tools = [...new Set(laps.slice(0, cycle).flatMap((turn) => turn.tools))];
      throw new AgentToolLoopError({ agent, repeats: limit, cycle, tools });
    }
  };
}

const isSameTurn = (one: string, other: string | undefined): boolean => one === other;

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
  /**
   * Run `fn` with the deadline on the ambient `ctx.signal`, so a tool — an `action()` reading its
   * own `ctx.signal`, a `fetch(url, { signal })` inside it — hears the deadline and can stop. A
   * tool that never reads the signal still runs to its own end after the run has been refused.
   */
  scope<T>(fn: () => T): T;
}

/** `ms` undefined is no deadline: the caller's signal, and two no-ops. */
export function runDeadline(
  agent: string,
  ms: number | undefined,
  caller: AbortSignal,
): RunDeadline {
  if (ms === undefined) {
    return { signal: caller, check: () => {}, guard: (work) => work, scope: (fn) => fn() };
  }
  const timer = AbortSignal.timeout(ms);
  const expired = (): AgentDeadlineError => new AgentDeadlineError({ agent, deadlineMs: ms });
  // The caller leaving first stays `X_ABORTED`: it is the truer account of why the run stopped.
  const byDeadline = (): boolean => timer.aborted && !caller.aborted;
  return {
    signal: AbortSignal.any([caller, timer]),
    scope: (fn) => withChildContext({ signal: timer }, fn),
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
