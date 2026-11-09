/**
 * One model turn's tool calls, run as a BOUNDED fan-out: at most `concurrency` in flight, results in
 * the order the model emitted the calls. The bound is what stands between an injected or confused
 * model asking for N calls and N concurrent invocations — and N pool checkouts — in one process.
 */

import type { Actor, Ctx } from '@ultimat3/core';
import { throwIfAborted } from '@ultimat3/core';
import type { RunDeadline } from './agent-guards';
import type { EmitChunk } from './agent-stream';
import { assistantTurn, toolResultTurn } from './agent-transcript';
import type { AiMessage, GenerateResult } from './provider';
import type { LlmToolCall, LlmToolResult, ProjectableAction } from './tools';
import { runLlmToolCall } from './tools';

/**
 * Calls of one turn in flight at once, unless the agent declares `maxToolConcurrency`. Eight keeps
 * the speed-up of a turn that asked for a handful (serial cost 5x wall clock for five) while a turn
 * that asked for fifty cannot drain a database pool sized for the whole process.
 */
export const DEFAULT_TOOL_CONCURRENCY = 8;

export interface ToolBatchOptions {
  readonly concurrency: number;
  readonly discloseErrors?: boolean;
  /** Asked before EACH call starts — the run's abort and deadline checks: a throw starts nothing more. */
  readonly beforeCall?: () => void;
}

/**
 * Runs `calls` with at most `concurrency` in flight. Order is by INDEX, not by completion: each
 * worker writes its result into the call's own slot, so a fast tool answering first cannot be paired
 * with a slow tool's call. A worker takes its next call only after `beforeCall` passed, so a run that
 * was aborted or ran out of time mid-batch starts nothing new.
 */
export async function runToolBatch(
  tools: readonly ProjectableAction[],
  calls: readonly LlmToolCall[],
  actor: Actor,
  options: ToolBatchOptions,
): Promise<readonly LlmToolResult[]> {
  const results: LlmToolResult[] = new Array<LlmToolResult>(calls.length);
  const disclosure =
    options.discloseErrors === undefined ? {} : { discloseErrors: options.discloseErrors };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      const index = next;
      next += 1;
      const call = calls[index];
      if (call === undefined) continue;
      options.beforeCall?.();
      results[index] = await runLlmToolCall(tools, call, actor, disclosure);
    }
  };
  const width = Math.max(1, Math.min(options.concurrency, calls.length));
  await Promise.all(Array.from({ length: width }, worker));
  return results;
}

/** What one run's tool turns share — fixed before the first turn. */
export interface ToolRun {
  readonly tools: readonly ProjectableAction[];
  readonly ctx: Ctx;
  /** Read ONCE from `ctx`, never from the model: the only identity any tool runs as. */
  readonly actor: Actor;
  readonly deadline: RunDeadline;
  readonly emit: EmitChunk;
  readonly concurrency: number;
  readonly discloseErrors: boolean;
  readonly maxTurns: number;
  readonly chars: number;
  readonly redact: (text: string) => string;
  readonly repeated: (calls: readonly LlmToolCall[], results: readonly LlmToolResult[]) => void;
}

/**
 * One turn that asked for tools: run them, stream what happened, refuse a repeating loop, and
 * answer with the transcript the next turn sends. `answers` are the same turn's `respond` calls.
 */
export async function toolTurn(
  run: ToolRun,
  turn: number,
  result: GenerateResult,
  requested: readonly LlmToolCall[],
  answers: readonly LlmToolCall[],
  messages: readonly AiMessage[],
): Promise<readonly AiMessage[]> {
  const { deadline, emit } = run;
  const stop = (): void => {
    throwIfAborted(run.ctx);
    deadline.check();
  };
  stop();
  for (const call of requested) emit({ type: 'tool_call', turn, id: call.id, name: call.name });
  const results = await deadline.guard(
    // Inside the deadline's scope, so each tool's own `ctx.signal` carries it.
    deadline.scope(() =>
      runToolBatch(run.tools, requested, run.actor, {
        concurrency: run.concurrency,
        discloseErrors: run.discloseErrors,
        beforeCall: stop,
      }),
    ),
  );
  results.forEach((done, index) => {
    const name = requested[index]?.name ?? '';
    emit({ type: 'tool_result', turn, id: done.toolUseId, name, isError: done.isError === true });
  });
  emit({ type: 'turn', turn, maxTurns: run.maxTurns });
  // Before the next turn is bought: the same calls with the same results cannot lead anywhere a
  // further turn would not also lead.
  run.repeated(requested, results);
  return [
    ...messages,
    assistantTurn(result),
    // Parallel tool use — one turn asking for a tool AND answering — is normal, and the answer is
    // speculative: it was written before the result it asked for existed. So the loop continues,
    // and the answer is REJECTED on the wire rather than dropped, because a replayed `respond`
    // block with no `tool_result` is a 400 and the whole run becomes `X_AI_PROVIDER_UNAVAILABLE`.
    toolResultTurn(results, run.chars, answers, run.redact),
  ];
}
