// The harness the `agent-compact*.test.ts` suites share: a model with a SMALL context window, a
// scripted provider that tells the summary call from a loop turn, and one declared agent whose
// tool returns a long page. Not shipped (`!src/**/*-fixture.ts`).

import { ctxOf, userActor } from '@ultimat3/core';
import type { Money } from '@ultimat3/money';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentCompaction, AgentCompactOption, AgentTurn } from './agent';
import { agent } from './agent';
import { SUMMARY_INSTRUCTION } from './agent-compact';
import type { AgentBudget } from './agent-def';
import { exactCostOf } from './cost';
import { echoProvider } from './echo-provider';
import type { Gateway } from './gateway';
import { providerGateway } from './gateway';
import { registerModel } from './models';
import { definePrompt } from './prompt';
import type {
  AiMessage,
  GenerateRequest,
  GenerateResult,
  Provider,
  StopReason,
  TokenUsage,
} from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const usd = (minor: number): Money => ({ minor, currency: 'USD' });

/** 3,000 tokens of window, 500 of them the completion: 2,500 of input room, 2,000 at `at: 0.8`. */
export const SMALL = 'compact-small';
/** A cheaper summary writer with more room. */
export const WRITER = 'compact-writer';
/** A summary writer whose completion is priced so high its worst case breaks any `costPerRun`. */
export const DEAR = 'compact-dear';
export const MAX_TOKENS = 500;
export const ROOM = 2_500;

const REASONING = { effort: false, adaptive: false, disableThinkingUpTo: undefined } as const;
const ROW = { cacheMinimumTokens: 1_024, reasoning: REASONING } as const;

export function registerCompactModels(): void {
  registerModel({
    id: SMALL,
    contextWindow: 3_000,
    maxOutput: 1_000,
    inputPerMillion: usd(500),
    outputPerMillion: usd(2_500),
    ...ROW,
  });
  registerModel({
    id: WRITER,
    contextWindow: 8_000,
    maxOutput: 2_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(400),
    ...ROW,
  });
  registerModel({
    id: DEAR,
    contextWindow: 8_000,
    maxOutput: 4_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(500_000_000),
    ...ROW,
  });
}

export const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
export const SUMMARY_USAGE: TokenUsage = {
  inputTokens: 300,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const SUMMARY = 'SUMMARY: read pages 1 to 3; each was long; nothing decided yet.';

export type Step = { readonly call: string; readonly input?: Record<string, unknown> };
export const READ: Step = { call: 'readDoc', input: { id: 'kb' } };
export const ANSWER: Step = { call: 'respond', input: { title: 'Tides' } };

/** How the summary call answers: text, a stop reason, or a throw. */
export interface SummaryReply {
  readonly text?: string;
  readonly stopReason?: StopReason;
  readonly toolCalls?: GenerateResult['toolCalls'];
  readonly fail?: unknown;
}

/** Whether `request` is a compaction's summary call: its last block is the instruction. */
export function isSummary(request: GenerateRequest): boolean {
  const last = request.messages.at(-1);
  if (last === undefined || typeof last.content === 'string') return false;
  const block = last.content.at(-1);
  return block?.type === 'text' && block.text === SUMMARY_INSTRUCTION;
}

export interface Script {
  /** Every request, in order. */
  readonly seen: GenerateRequest[];
  /** The loop's turns alone. */
  readonly loop: GenerateRequest[];
  /** The summary calls alone. */
  readonly summaries: GenerateRequest[];
  readonly gateway: Gateway;
}

/** Loop call N answers `steps[N-1]`, the last one repeating; a summary call answers `summary`. */
export function scripted(
  steps: readonly Step[],
  summary: SummaryReply = { text: SUMMARY },
  models: readonly string[] = [SMALL, WRITER, DEAR],
): Script {
  const seen: GenerateRequest[] = [];
  const loop: GenerateRequest[] = [];
  const summaries: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models,
    generate(request) {
      seen.push(request);
      const model = request.model ?? SMALL;
      if (isSummary(request)) {
        summaries.push(request);
        if (summary.fail !== undefined) return Promise.reject(summary.fail);
        return Promise.resolve(reply(model, summary.text ?? '', summary.toolCalls ?? [], summary));
      }
      loop.push(request);
      const step = steps[Math.min(loop.length - 1, steps.length - 1)] ?? ANSWER;
      const call = { id: `call-${loop.length}`, name: step.call, input: step.input ?? {} };
      return Promise.resolve(reply(model, '', [call], { stopReason: 'tool_use' }, USAGE));
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  registerCompactModels();
  pages = 0;
  const gateway = providerGateway({
    defaultModel: SMALL,
    providers: [provider],
    sleep: () => Promise.resolve(),
  });
  configureAi({ gateway });
  return { seen, loop, summaries, gateway };
}

function reply(
  model: string,
  text: string,
  toolCalls: GenerateResult['toolCalls'],
  shape: { readonly stopReason?: StopReason },
  usage: TokenUsage = SUMMARY_USAGE,
): GenerateResult {
  return {
    model,
    text,
    toolCalls,
    stopReason: shape.stopReason ?? 'end_turn',
    stopDetails: undefined,
    usage,
    cost: costOf(model, usage),
    costExact: exactCostOf(model, usage),
  };
}

/** Pages read since the last `scripted()`: each result differs, so no run trips the loop guard. */
let pages = 0;
export const PAGE = `${'The tide table for the bay, hour by hour. '.repeat(40)}`;
export const readDoc: ProjectableAction = {
  name: 'readDoc',
  description: 'Read one document',
  mcp: { expose: true },
  run: () => Promise.resolve(`page ${++pages}: ${PAGE}`),
};

export const Input = t.object({ topic: t.string });
export const Output = t.object({ title: t.string });
export const INPUT = { topic: 'tides' };
export const RULES = 'RULES: answer from the knowledge base only.';
export const ctx = () => ctxOf({ actor: userActor({ id: 'u-1', orgId: 'org-1' }) });

export interface Declared {
  readonly compact?: AgentCompactOption;
  readonly model?: string;
  readonly budget?: AgentBudget;
  readonly maxTurns?: number;
  readonly promptCache?: { readonly session: string };
  /** Reuse one prompt across declarations, so two handles can be compared byte for byte. */
  readonly prompt?: ReturnType<typeof promptFor>;
  readonly onCompact?: (event: AgentCompaction) => void;
}

let seq = 0;
export const promptFor = (id: string) =>
  definePrompt<{ topic: string }>({
    id,
    version: '1.0.0',
    system: RULES,
    template: 'Write about {{topic}}.',
  });

export function declare(
  extra: Declared = {},
  events: AgentCompaction[] = [],
  turns: AgentTurn[] = [],
) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    model: extra.model ?? SMALL,
    prompt: extra.prompt ?? promptFor(`compacting-${seq}`),
    vars: ({ input }) => ({ topic: input.topic }),
    system: () => ({ stable: 'INDEX\nkb: tides', run: 'Today is 2026-10-21.' }),
    tools: [readDoc],
    policy: allow(),
    maxTokens: MAX_TOKENS,
    maxTurns: extra.maxTurns ?? 12,
    ...(extra.compact === undefined ? {} : { compact: extra.compact }),
    ...(extra.budget === undefined ? {} : { budget: extra.budget }),
    ...(extra.promptCache === undefined ? {} : { promptCache: extra.promptCache }),
    onCompact: extra.onCompact ?? ((event) => void events.push(event)),
    onTurn: (turn) => void turns.push(turn),
  }).named(`compacting${seq}`);
}

/** Every `tool_use` answered by the very next message, and no `tool_result` answering nothing. */
export function pairsIntact(messages: readonly AiMessage[]): boolean {
  let open = new Set<string>();
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [] : message.content;
    const answered = new Set(
      blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])),
    );
    if (open.size !== answered.size || [...open].some((id) => !answered.has(id))) return false;
    open = new Set(blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
  }
  return true;
}

/** Whether a message is a compacted first message: it carries the summary block. */
export const compactedHead = (message: AiMessage | undefined): boolean =>
  message !== undefined &&
  typeof message.content !== 'string' &&
  message.content.some((b) => b.type === 'text' && b.text.startsWith('[compacted:'));
