// Single responsibility: what an `agent({ compact })` declaration says — the option, its defaults,
// the screen it passes at declaration, and the one event a compaction reports. ./agent-compact
// owns the run-time half that reads them.

import { finiteCount } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { AiRequestInvalidError } from './errors';
import type { ModelId } from './models';
import type { TokenUsage } from './provider';

/** The fraction of the model's input room (`contextWindow - maxTokens`) that triggers a compaction. */
export const DEFAULT_COMPACT_AT = 0.8;

/** The most recent turns sent verbatim after a compaction — one turn is one assistant message and the user message answering it. */
export const DEFAULT_KEEP_TURNS = 4;

/** The summary call's completion ceiling when the declaration names none (held under `maxTokens`). */
export const DEFAULT_MAX_SUMMARY_TOKENS = 2_048;

export interface AgentCompactRule {
  /** Compact once the next request is estimated over this fraction of the input room. 0 < at <= 1. */
  readonly at?: number;
  /** Turns kept verbatim, the newest. At least 1: the model must read the tool results it just asked for. */
  readonly keepTurns?: number;
  /** The model that writes the summary. Default: the run's own — which also reads the cached prefix. */
  readonly model?: ModelId;
  /** The summary call's completion ceiling. Default `min(2,048, maxTokens)`. */
  readonly maxSummaryTokens?: number;
}

/** `'auto'` (the default) is `{}` — every default above. `'off'` never compacts and never checks. */
export type AgentCompactOption = 'auto' | 'off' | AgentCompactRule;

/** A declaration's `compact`, screened, defaults applied — `undefined` for `'off'`. */
export interface CompactPlan {
  readonly at: number;
  readonly keepTurns: number;
  readonly model: ModelId | undefined;
  readonly maxSummaryTokens: number;
}

/** One compaction attempt, as an observer sees it. Facts only — never the summary, never the transcript. */
export interface AgentCompaction {
  /** The turn the compaction was for: the request about to be sent. */
  readonly turn: number;
  readonly outcome: 'compacted' | 'failed';
  /** On `failed`: why. The run then went on uncompacted, or stopped with `X_AGENT_CONTEXT_EXHAUSTED`. */
  readonly reason?: string;
  /** The next request's estimated prompt tokens before the compaction. */
  readonly before: number;
  /** ...and after it — `before` again when it failed. */
  readonly after: number;
  /** The input room: the model's `contextWindow` less `maxTokens`. */
  readonly limit: number;
  /** Turns folded into the summary (0 when none were old enough). */
  readonly summarised: number;
  /** Turns sent verbatim after it. */
  readonly kept: number;
  /** Which compaction of the run this was, continuations included — 1-based. Counts successes only. */
  readonly compactions: number;
  /** The model that was asked for the summary. */
  readonly model: ModelId;
  /** The summary call's usage and cost; absent when no call was made. Already in the run's total. */
  readonly usage?: TokenUsage;
  readonly cost?: Money;
}

const SUBJECT = 'agent';

/** At DECLARATION, like every other bound: an `agent()` runs at module scope, so a bad one fails the boot. */
export function screenCompact(
  option: AgentCompactOption | undefined,
  maxTokens: number,
): CompactPlan | undefined {
  if (option === 'off') return undefined;
  const rule: AgentCompactRule = option === undefined || option === 'auto' ? {} : option;
  if (typeof rule !== 'object' || rule === null) {
    throw new AiRequestInvalidError({
      detail: `agent compact is ${String(option)}, which is not 'auto', 'off' or a rule`,
      fix: "compact: 'auto'   # on the agent — or 'off', or { at: 0.8, keepTurns: 4 }",
    });
  }
  const at = rule.at ?? DEFAULT_COMPACT_AT;
  // `estimate > NaN * room` is false on every turn: compaction silently never runs.
  if (!Number.isFinite(at) || at <= 0 || at > 1) {
    throw new AiRequestInvalidError({
      detail: `agent compact.at is ${at}; it is a fraction of the context window, above 0 and at most 1`,
      fix: 'compact: { at: 0.8 }   # on the agent — compact once the next request is 80% of the room',
    });
  }
  const keepTurns = finiteCount(
    SUBJECT,
    'compact.keepTurns',
    rule.keepTurns ?? DEFAULT_KEEP_TURNS,
    1,
  );
  const maxSummaryTokens = finiteCount(
    SUBJECT,
    'compact.maxSummaryTokens',
    rule.maxSummaryTokens ?? Math.min(DEFAULT_MAX_SUMMARY_TOKENS, maxTokens),
    1,
  );
  return { at, keepTurns, model: rule.model, maxSummaryTokens };
}
