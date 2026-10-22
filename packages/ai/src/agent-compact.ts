// Single responsibility: auto-compaction for ONE `agent()` run — the trigger before each turn, the
// cut between turns, the one summary call, and the transcript rebuilt around it.
//
// Shaped by the provider prompt cache (./prompt-cache): a cache is a prefix match, so everything
// before the messages — the tools, the system prompt and its stable block — is sent byte for byte
// as it was, and the summary call is the run's OWN request up to the cut plus one instruction, so
// it reads the prefix an earlier turn wrote instead of paying for it again. Only the messages
// change, once, and the next turn writes the new, shorter prefix.
//
// Never a truncation: a summary that cannot be had leaves the transcript whole, and a whole
// transcript that does not fit is `X_AGENT_CONTEXT_EXHAUSTED` before it is sent.

import type { Ctx, Span } from '@ultimat3/core';
import { stringField, throwIfAborted } from '@ultimat3/core';
import type { AgentCompaction, CompactPlan } from './agent-compact-def';
import { AgentContextExhaustedError } from './agent-errors';
import type { RunDeadline } from './agent-guards';
import type { Gateway } from './gateway';
import type { ModelId } from './models';
import { modelSpec } from './models';
import type { AiContentBlock, AiMessage, GenerateRequest, GenerateResult } from './provider';
import { estimateInputTokens, estimateTextTokens, isTruncated } from './provider';
import { runMeter } from './run-meter';

/** How a compacted first message's summary block starts — the marker a later compaction reads. */
export const COMPACTED_MARK = '[compacted:';

/** What the summary call is asked, appended to the last message it is sent. */
export const SUMMARY_INSTRUCTION = `${COMPACTED_MARK} instruction] This conversation is about to be shortened to fit the context window: everything after the task in the first message, any earlier summary included, will be replaced by the summary you write now. Summarise it for yourself — what you did, every tool you called and what it returned (keep exact ids, numbers, names and quotes you will still need), what you concluded, and what remains to do. Do not call any tool. Reply with the summary as plain text only.`;

/** The run's own stops: thrown as themselves from the summary call, never read as its failure. */
const RUN_STOPS: ReadonlySet<string> = new Set([
  'X_AI_BUDGET_EXCEEDED',
  'X_AGENT_DEADLINE',
  'X_ABORTED',
]);

export interface CompactorInput {
  readonly agent: string;
  readonly plan: CompactPlan;
  /** The run's request with no messages: its model, system, tools and cache hint. */
  readonly base: GenerateRequest;
  readonly model: ModelId;
  /** Compactions the handle being continued already holds. */
  readonly prior: number;
  readonly gateway: Gateway;
  readonly deadline: RunDeadline;
  readonly ctx: Ctx;
  readonly span: Span;
  readonly onCompact: ((event: AgentCompaction) => void | Promise<void>) | undefined;
  /** `costPerRun` for the summary call, as for a turn: throws `X_AI_BUDGET_EXCEEDED` pre-flight. */
  readonly assertCost: (request: GenerateRequest) => void;
}

export interface Compactor {
  /** The messages the next turn sends: as given, compacted, or refused. */
  fit(messages: readonly AiMessage[], turn: number): Promise<readonly AiMessage[]>;
  /** Compactions so far, continuations included — what the handle's `compacted` carries. */
  count(): number;
}

/**
 * The prompt half of a request, as the gateway estimates it (`estimateInputTokens`), plus the tool
 * definitions that estimate leaves out — every one of them is sent on every turn.
 */
export function promptTokens(request: GenerateRequest): number {
  return estimateInputTokens(request) + estimateTextTokens(JSON.stringify(request.tools ?? []));
}

/** The input room of `model` for a completion ceiling of `maxTokens`. Never below one token. */
export function roomOf(model: ModelId, maxTokens: number): number {
  return Math.max(1, modelSpec(model).contextWindow - maxTokens);
}

export function compactor(input: CompactorInput): Compactor {
  const { plan, base, model, span } = input;
  const writer = plan.model ?? model;
  // Before the first turn: an unregistered summary model is `X_AI_MODEL_UNKNOWN` at run start,
  // not in the middle of the run whose transcript it was supposed to save.
  modelSpec(writer);
  const limit = roomOf(model, base.maxTokens);
  let count = input.prior;
  // The estimate a compaction is attempted above. After a FAILED attempt it rises to the room
  // itself: each attempt is a billed call, and one that just failed is tried again only when the
  // run can no longer go on without it — never once per turn while it still fits.
  let trigger = plan.at * limit;

  const report = async (event: AgentCompaction): Promise<void> => {
    span.addEvent('agent.compact', {
      'agent.compact.turn': event.turn,
      'agent.compact.outcome': event.outcome,
      'agent.compact.before_tokens': event.before,
      'agent.compact.after_tokens': event.after,
      'agent.compact.limit_tokens': event.limit,
      'agent.compact.summarised_turns': event.summarised,
      'agent.compact.kept_turns': event.kept,
      ...(event.reason === undefined ? {} : { 'agent.compact.reason': event.reason }),
      ...(event.cost === undefined ? {} : { 'llm.cost.minor': event.cost.minor }),
    });
    await input.onCompact?.(event);
  };

  const fit = async (
    messages: readonly AiMessage[],
    turn: number,
  ): Promise<readonly AiMessage[]> => {
    const before = promptTokens({ ...base, messages });
    if (before <= trigger) return messages;
    const facts = { turn, before, limit, model: writer };
    const split = splitTurns(messages, plan.keepTurns);
    const kept = split === undefined ? Math.floor(messages.length / 2) : plan.keepTurns;
    const failed = async (
      reason: string,
      summarised: number,
      call?: GenerateResult,
    ): Promise<readonly AiMessage[]> => {
      await report({
        ...facts,
        outcome: 'failed',
        reason,
        after: before,
        summarised,
        kept,
        compactions: count,
        ...(call === undefined ? {} : { usage: call.usage, cost: call.cost }),
      });
      // Still fits: the run goes on whole. Compaction is how a run stays under the window, never
      // a condition of running — the turns that fit are not refused for a summary that failed.
      trigger = limit;
      if (before <= limit) return messages;
      throw new AgentContextExhaustedError({
        agent: input.agent,
        model,
        estimate: before,
        limit,
        reason,
      });
    };

    if (split === undefined) {
      return failed(`there is no turn older than the last ${plan.keepTurns} to summarise`, 0);
    }
    const summarised = split.older.length / 2;
    const request = summaryRequest(base, writer, plan.maxSummaryTokens, split);
    if (promptTokens(request) > roomOf(writer, plan.maxSummaryTokens)) {
      return failed(`the turns to summarise do not fit model "${writer}" either`, summarised);
    }
    throwIfAborted(input.ctx);
    input.deadline.check();
    input.assertCost(request);
    let result: GenerateResult;
    try {
      // Its own meter, inside the run's: the bill reaches the run as a nested call's does — on the
      // same ledger, in `tokensPerRun` and `costPerRun`, priced at the summary model's own rates.
      result = await input.deadline.guard(runMeter().call(input.gateway.generate(request)));
    } catch (error) {
      throwIfAborted(input.ctx);
      const code = stringField(error, 'code');
      if (code !== undefined && RUN_STOPS.has(code)) throw error;
      return failed(`the summary call failed${code === undefined ? '' : ` (${code})`}`, summarised);
    }
    const summary = result.text.trim();
    if (result.stopReason === 'refusal') {
      return failed('the summary call was refused', summarised, result);
    }
    if (isTruncated(result.stopReason)) {
      return failed(
        `the summary was cut off at maxSummaryTokens (${plan.maxSummaryTokens})`,
        summarised,
        result,
      );
    }
    if (summary === '') return failed('the summary call answered no text', summarised, result);
    const compacted = [compactedHead(split.head, summarised, summary), ...split.kept];
    const after = promptTokens({ ...base, messages: compacted });
    if (after >= before) {
      return failed('the summary was no shorter than the turns it replaced', summarised, result);
    }
    if (after > limit) {
      return failed('even compacted, the next request is over the window', summarised, result);
    }
    count += 1;
    trigger = plan.at * limit;
    await report({
      ...facts,
      outcome: 'compacted',
      after,
      summarised,
      kept,
      compactions: count,
      usage: result.usage,
      cost: result.cost,
    });
    return compacted;
  };

  return { fit, count: () => count };
}

interface Split {
  /** The first user message: the rendered prompt, and any earlier summary. */
  readonly head: AiMessage;
  /** Whole turns — an assistant message and the user message answering it — oldest first. */
  readonly older: readonly AiMessage[];
  /** The last `keepTurns` turns, verbatim. */
  readonly kept: readonly AiMessage[];
}

/**
 * The transcript cut BETWEEN turns, never inside one. A loop's messages are the prompt, then
 * assistant/user pairs — each user message answering every `tool_use` of the assistant message
 * before it — so a cut before an assistant message cannot separate a call from its result.
 * `undefined` when no whole turn is older than the kept ones.
 */
function splitTurns(messages: readonly AiMessage[], keepTurns: number): Split | undefined {
  const head = messages[0];
  const cut = messages.length - 2 * keepTurns;
  if (head === undefined || head.role !== 'user' || cut < 3) return undefined;
  if (messages[cut]?.role !== 'assistant' || messages[cut - 1]?.role !== 'user') return undefined;
  return { head, older: messages.slice(1, cut), kept: messages.slice(cut) };
}

/**
 * The run's own request up to the cut, plus the instruction — the same tools, system and cache
 * hint, so the provider reads the prefix an earlier turn wrote. A different summary model takes
 * none of the run model's reasoning controls: one it lacks would be `X_AI_REQUEST_INVALID`.
 */
function summaryRequest(
  base: GenerateRequest,
  writer: ModelId,
  maxTokens: number,
  split: Split,
): GenerateRequest {
  const messages = withInstruction([split.head, ...split.older]);
  if (writer === base.model) return { ...base, messages, maxTokens };
  const { effort: _effort, thinking: _thinking, ...rest } = base;
  return { ...rest, model: writer, messages, maxTokens };
}

/** Roles must alternate, and the older turns end on a user message: the instruction joins it. */
function withInstruction(messages: readonly AiMessage[]): readonly AiMessage[] {
  const last = messages.at(-1);
  const text = { type: 'text' as const, text: SUMMARY_INSTRUCTION };
  if (last === undefined) return [{ role: 'user', content: SUMMARY_INSTRUCTION }];
  return [...messages.slice(0, -1), { role: 'user', content: [...blocksOf(last), text] }];
}

/**
 * The first message, rebuilt: the prompt as it was sent (an earlier summary dropped — the new one
 * covers it), then the summary, marked. The model reads it as its own notes, said to be so.
 */
function compactedHead(head: AiMessage, turns: number, summary: string): AiMessage {
  const prompt = blocksOf(head).filter(
    (block) => !(block.type === 'text' && block.text.startsWith(COMPACTED_MARK)),
  );
  const note = `${COMPACTED_MARK} ${turns} earlier turn${turns === 1 ? '' : 's'} of this run were summarised to fit the context window. Your summary of everything after the task above:]\n\n${summary}`;
  return { role: 'user', content: [...prompt, { type: 'text', text: note }] };
}

function blocksOf(message: AiMessage): readonly AiContentBlock[] {
  return typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content;
}
