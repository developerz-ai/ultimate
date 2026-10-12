// Single responsibility: what the loop does with ONE completed model turn before it acts on it —
// report it, and refuse the two stops that are not an answer. Split from ./agent at its line
// ceiling.

import type { Span } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { AgentDef, AgentTurn } from './agent-def';
import { LlmRefusedError } from './errors';
import { moreCapableThan } from './models';
import type { PromptVars } from './prompt';
import type { GenerateRequest, GenerateResult } from './provider';

/**
 * One turn, reported twice: onto the span every run already opens, and to the declaration's own
 * hook. The span event is free — nothing to install, and a trace is where a stalled run is
 * actually diagnosed — and the hook is what a progress indicator or a per-turn spend line reads.
 *
 * Awaited, and not guarded: a throw from `onTurn` fails the run. It is the app's code on the run's
 * path, and an observer that quietly stopped working reads exactly like one that is fine.
 */
export async function observeTurn<
  TInput extends StandardSchemaV1,
  TOutput extends StandardSchemaV1,
  V extends PromptVars,
>(def: AgentDef<TInput, TOutput, V>, span: Span, event: AgentTurn): Promise<void> {
  span.addEvent('agent.turn', {
    'agent.turn': event.turn,
    'agent.turn.tool_calls': event.toolCalls.length,
    'llm.stop': event.stopReason,
    'llm.cost.minor': event.cost.minor,
    'agent.turn.repair': event.repairOf !== undefined,
    // What the provider's prompt cache did for this turn — the two numbers that say whether the
    // stable prefix is really stable.
    'llm.cache.read_tokens': event.usage.cacheReadTokens,
    'llm.cache.write_tokens': event.usage.cacheWriteTokens,
  });
  await def.onTurn?.(event);
}

/** Refuse before the answer is read, for the reason `llm()` does: a refusal is a 200 with no answer. */
export function assertAnswerable(
  result: GenerateResult,
  name: string,
  request: GenerateRequest,
): void {
  if (result.stopReason !== 'refusal') return;
  throw new LlmRefusedError({
    prompt: name,
    model: result.model,
    alternative: moreCapableThan(result.model, request),
    category: result.stopDetails?.category,
    explanation: result.stopDetails?.explanation,
  });
}
