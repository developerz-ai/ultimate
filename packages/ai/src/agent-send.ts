// Single responsibility: sending one `agent()` turn — and, when the provider refuses it as over
// the window (`X_AI_CONTEXT_OVERFLOW`), compacting once and sending it again. The loop still holds
// the transcript after that 400, so the refusal is recoverable; a second one, or `compact: 'off'`,
// is `X_AGENT_CONTEXT_EXHAUSTED` with the provider's own words as its reason.

import { isUltimateError, renderThrowable, stringField } from '@ultimat3/core';
import type { Compactor } from './agent-compact';
import { promptTokens, roomOf } from './agent-compact';
import { AgentContextExhaustedError } from './agent-errors';
import type { ModelId } from './models';
import type { AiMessage, GenerateRequest, GenerateResult } from './provider';

const OVERFLOW = 'X_AI_CONTEXT_OVERFLOW';

export interface TurnSend {
  readonly agent: string;
  readonly model: ModelId;
  /** The run's request with no messages. */
  readonly base: GenerateRequest;
  /** `undefined` under `compact: 'off'`: an overflow then ends the run. */
  readonly compacting: Compactor | undefined;
  /** One metered, deadline-guarded, cost-checked provider call. */
  readonly send: (request: GenerateRequest) => Promise<GenerateResult>;
}

export interface SentTurn {
  readonly result: GenerateResult;
  /** What was sent: the messages given, or their forced compaction. */
  readonly messages: readonly AiMessage[];
}

/** The provider's text, read totally: the value came out of a `catch`. */
const refusalOf = (error: unknown): string =>
  (isUltimateError(error) ? stringField(error.meta, 'detail') : undefined) ??
  renderThrowable(error);

const isOverflow = (error: unknown): boolean => stringField(error, 'code') === OVERFLOW;

/**
 * Send `messages` as turn `turn`. `onCompacted` hears the forced compaction before the re-send, so
 * a failure after it resumes from the shorter transcript.
 */
export async function sendTurn(
  input: TurnSend,
  messages: readonly AiMessage[],
  turn: number,
  onCompacted: (messages: readonly AiMessage[]) => void,
): Promise<SentTurn> {
  const { base, compacting } = input;
  const exhausted = (sent: readonly AiMessage[], error: unknown, reason: string): never => {
    throw new AgentContextExhaustedError({
      agent: input.agent,
      model: input.model,
      estimate: promptTokens({ ...base, messages: sent }),
      limit: roomOf(input.model, base.maxTokens),
      reason,
      refused: refusalOf(error),
    });
  };
  const observed = async (sent: readonly AiMessage[]): Promise<SentTurn> => {
    const request: GenerateRequest = { ...base, messages: sent };
    const result = await input.send(request);
    compacting?.observe(result.usage, request);
    return { result, messages: sent };
  };
  try {
    return await observed(messages);
  } catch (error) {
    if (!isOverflow(error)) throw error;
    if (compacting === undefined) {
      return exhausted(messages, error, "compact is 'off', so nothing could shorten it");
    }
    const compacted = await compacting.force(messages, turn, refusalOf(error));
    onCompacted(compacted);
    try {
      return await observed(compacted);
    } catch (again) {
      if (!isOverflow(again)) throw again;
      return exhausted(compacted, again, 'the compacted request was refused as well');
    }
  }
}
