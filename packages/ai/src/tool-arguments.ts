// Single responsibility: reading a tool call's argument STRING, and deciding what an unreadable
// one means once the turn's stop reason is known. One copy for both wire formats, streamed or not.
//
// "The arguments are not JSON" is two different events, and neither is the provider being
// unavailable — which is what both wires used to report it as, under the one code this package
// classifies retryable, with the answer already billed:
//   - the turn was CUT OFF mid-arguments. The stop reason says so, and the fragment is dropped: a
//     fragment is never a call, and `llm()` / `agent()` refuse a truncated turn before reading it.
//   - the turn FINISHED and the model wrote broken JSON. That is `X_LLM_TOOL_ARGUMENTS_INVALID`,
//     thrown with the usage the provider reported, so the gateway records the bill instead of
//     releasing the reservation and nothing retries a request that was answered.

import type { Money } from '@ultimat3/money';
import { AiProviderUnexpectedError, LlmToolArgumentsError } from './answer-errors';
import { billedCall } from './billed';
import type { ModelId } from './models';
import type { StopReason, TokenUsage } from './provider';
import { isTruncated } from './provider';

/** A tool call whose arguments could not be read. Never the text: it is the model's, unscreened. */
export interface MalformedToolCall {
  readonly name: string;
  /** Characters of argument text that arrived. */
  readonly chars: number;
  /**
   * The fragments carried neither an `index` nor an `id`, and more than one named a tool: two
   * calls that cannot be told apart. Refused whole — never run as one call with merged arguments.
   */
  readonly unkeyed?: boolean;
}

/**
 * The arguments as an object, or `undefined` when the string is not JSON. A blank string is `{}`:
 * a tool that takes no arguments sends `''` or `'{}'`, and neither is a fault. JSON that is not an
 * object is `{}` too — `input` is untrusted, and a string under `Record<string, unknown>` is a
 * type lie every later reader indexes into.
 */
export function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Refuse a FINISHED turn that carried unreadable arguments. Called by a provider once usage is
 * known — on a stream that is the last frame, long after the call closed — so the error can say
 * what the answer cost. A truncated turn passes: its fragments were already dropped.
 */
export function assertToolArguments(turn: {
  readonly provider: string;
  readonly model: ModelId;
  readonly stopReason: StopReason;
  readonly malformed: readonly MalformedToolCall[];
  readonly usage: TokenUsage;
  readonly cost: Money;
  /** The raw finish reason, when the wire did not know it (`openai-wire.ts`). */
  readonly unknownFinish?: string | undefined;
}): void {
  // A reason nobody knows is not truncation. A turn that is whole was read as a stop; one that is
  // not — arguments that do not parse — or one the endpoint itself called an `error`, is refused
  // by name, with its bill, instead of being guessed at.
  const unknown = turn.unknownFinish;
  if (unknown !== undefined && (turn.malformed.length > 0 || unknown.toLowerCase() === 'error')) {
    throw new AiProviderUnexpectedError({
      provider: turn.provider,
      model: turn.model,
      reason: unknown,
      billed: billedCall(turn.usage, turn.cost),
    });
  }
  const first = turn.malformed[0];
  if (first === undefined || isTruncated(turn.stopReason)) return;
  throw new LlmToolArgumentsError({
    provider: turn.provider,
    model: turn.model,
    tool: first.name,
    chars: first.chars,
    unkeyed: first.unkeyed === true,
    billed: billedCall(turn.usage, turn.cost),
  });
}
