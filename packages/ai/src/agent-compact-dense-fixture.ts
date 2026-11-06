// The harness the measured-trigger and overflow suites share: a model that counts tokens the way a
// provider does on dense JSON (about 1.3 characters a token, so ~3x the four-a-token estimate), and
// refuses a request over the room as a real wire does. Not shipped (`!src/**/*-fixture.ts`).

import { allow } from '@ultimat3/policy';
import type { AgentCompaction, AgentCompactOption } from './agent';
import { agent } from './agent';
import { promptTokens } from './agent-compact';
import {
  Input,
  isSummary,
  MAX_TOKENS,
  Output,
  promptFor,
  ROOM,
  registerCompactModels,
  SMALL,
  SUMMARY,
  SUMMARY_USAGE,
} from './agent-compact-fixture';
import { AiContextOverflowError } from './context-overflow';
import { exactCostOf } from './cost';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

/** Characters a token on the "wire" below: dense JSON. The estimate assumes four. */
export const CHARS_PER_TOKEN = 1.3;

/** What the provider counts for `request`: its estimate, at 1.3 characters a token. */
export const realTokens = (request: GenerateRequest): number =>
  Math.ceil((promptTokens(request) * 4) / CHARS_PER_TOKEN);

export const OVERFLOW_TEXT = 'prompt is too long: 2921 tokens > 2500 maximum';

export interface DenseScript {
  /** `readRows` calls before the model answers. */
  readonly reads: number;
  /** Report the real count (default) or zero, as a wire with no usage does. */
  readonly reports?: 'real' | 'zero';
  /** Refuse loop call N (1-based) as over the window; default: whenever it really is. */
  readonly refuse?: (call: number, real: number) => boolean;
}

export interface Dense {
  readonly loop: GenerateRequest[];
  readonly summaries: GenerateRequest[];
  /** Loop calls the provider refused as over the window. */
  readonly refused: number[];
}

const reply = (toolCalls: GenerateResult['toolCalls'], usage: TokenUsage): GenerateResult => ({
  model: SMALL,
  text: '',
  toolCalls,
  stopReason: 'tool_use',
  stopDetails: undefined,
  usage,
  cost: costOf(SMALL, usage),
  costExact: exactCostOf(SMALL, usage),
});

export function dense(script: DenseScript): Dense {
  const out: Dense = { loop: [], summaries: [], refused: [] };
  const refuse = script.refuse ?? ((_call: number, real: number) => real > ROOM);
  const provider: Provider = {
    name: 'dense',
    models: [SMALL],
    generate(request) {
      if (isSummary(request)) {
        out.summaries.push(request);
        return Promise.resolve({
          ...reply([], SUMMARY_USAGE),
          text: SUMMARY,
          stopReason: 'end_turn',
        });
      }
      out.loop.push(request);
      const call = out.loop.length;
      const real = realTokens(request);
      if (refuse(call, real)) {
        out.refused.push(call);
        return Promise.reject(
          new AiContextOverflowError({
            provider: 'dense',
            model: SMALL,
            status: 400,
            detail: OVERFLOW_TEXT,
          }),
        );
      }
      const answered = call - out.refused.length;
      const tool =
        answered > script.reads
          ? { id: `c${call}`, name: 'respond', input: { title: 'Rows' } }
          : { id: `c${call}`, name: 'readRows', input: {} };
      const input = script.reports === 'zero' ? 0 : real;
      return Promise.resolve(
        reply([tool], {
          inputTokens: input,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
      );
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  registerCompactModels();
  rows = 0;
  configureAi({
    gateway: providerGateway({ defaultModel: SMALL, providers: [provider], sleep: async () => {} }),
  });
  return out;
}

let rows = 0;
/** About 140 characters of dense JSON per call, each distinct so no run trips the loop guard. */
const readRows: ProjectableAction = {
  name: 'readRows',
  description: 'Read the next rows',
  mcp: { expose: true },
  run: () => Promise.resolve(`[${rows++},${'{"i":1,"q":7,"z":0},'.repeat(7)}]`),
};

let seq = 0;
export function denseAgent(compact: AgentCompactOption, events: AgentCompaction[], maxTurns = 20) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    model: SMALL,
    prompt: promptFor(`dense-${seq}`),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [readRows],
    policy: allow(),
    maxTokens: MAX_TOKENS,
    maxTurns,
    compact,
    onCompact: (event) => void events.push(event),
  }).named(`denseAgent${seq}`);
}
