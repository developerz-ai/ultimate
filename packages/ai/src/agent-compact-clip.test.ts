/**
 * A forced summary that would overflow too. The provider refuses a turn whose newest turn is
 * small and whose oldest holds one huge tool result: the run's own request up to the cut is then
 * the refused request plus an instruction, and cannot fit. Before 2026-11 that was
 * `X_AGENT_CONTEXT_EXHAUSTED`; now the turns go to the summary call as text, the oldest result
 * clipped to its start and end, and the run answers. The run's own transcript is never clipped.
 */

import { describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import type { AgentCompaction } from './agent';
import { agent } from './agent';
import {
  ANSWER,
  ctx,
  declare as declareSmall,
  INPUT,
  Input,
  isSummary,
  Output,
  promptFor,
  READ,
  scripted,
} from './agent-compact-fixture';
import { blocksOf, TRANSCRIPT_NOTE } from './agent-compact-request';
import { SUMMARY_CLIP_CHARS } from './agent-compact-text';
import { AiContextOverflowError } from './context-overflow';
import { exactCostOf } from './cost';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { registerModel } from './models';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { installAiGateway, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const MODEL = 'compact-clip';
const HUGE = `HEAD-OF-LOG ${'0123456789'.repeat(1_400)}MIDDLE-OF-LOG${'9876543210'.repeat(1_400)} TAIL-OF-LOG`;
const USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

interface Run {
  readonly loop: GenerateRequest[];
  readonly summaries: GenerateRequest[];
}

const result = (toolCalls: GenerateResult['toolCalls'], text = ''): GenerateResult => ({
  model: MODEL,
  text,
  toolCalls,
  stopReason: toolCalls.length === 0 ? 'end_turn' : 'tool_use',
  stopDetails: undefined,
  usage: USAGE,
  cost: costOf(MODEL, USAGE),
  costExact: exactCostOf(MODEL, USAGE),
});

/** Loop call 3 is refused as over the window; every other call answers. Three reads, then respond. */
function provider(): Run {
  const run: Run = { loop: [], summaries: [] };
  const gen: Provider = {
    name: 'clip',
    models: [MODEL],
    generate(request) {
      if (isSummary(request)) {
        run.summaries.push(request);
        return Promise.resolve(result([], 'SUMMARY: read a long log; it ended TAIL-OF-LOG.'));
      }
      run.loop.push(request);
      const call = run.loop.length;
      if (call === 3) {
        const detail = 'prompt is too long';
        return Promise.reject(
          new AiContextOverflowError({ provider: 'clip', model: MODEL, status: 400, detail }),
        );
      }
      const answered = call > 3 ? call - 1 : call;
      const tool =
        answered > 3
          ? { id: `c${call}`, name: 'respond', input: { title: 'Logs' } }
          : { id: `c${call}`, name: 'readLog', input: { page: answered } };
      return Promise.resolve(result([tool]));
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  // 10,500 of window, 500 of completion: a room of 10,000, the huge result about 7,000 of it.
  const usd = (minor: number) => ({ minor, currency: 'USD' });
  registerModel({
    id: MODEL,
    contextWindow: 10_500,
    maxOutput: 1_000,
    inputPerMillion: usd(100),
    outputPerMillion: usd(400),
    cacheMinimumTokens: 1_024,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
  installAiGateway(
    providerGateway({ defaultModel: MODEL, providers: [gen], sleep: async () => {} }),
  );
  return run;
}

let reads = 0;
let seq = 0;
const readLog: ProjectableAction = {
  name: 'readLog',
  description: 'Read one page of the log',
  mcp: { expose: true },
  run: () => Promise.resolve(reads++ === 0 ? HUGE : `page ${reads}: ok`),
};

function declare(events: AgentCompaction[]) {
  reads = 0;
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    model: MODEL,
    prompt: promptFor(`clip-${seq}`),
    vars: ({ input }) => ({ topic: input.topic }),
    system: () => ({ stable: 'INDEX\nlogs: one', run: 'Today is 2026-11-06.' }),
    tools: [readLog],
    policy: allow(),
    maxTokens: 500,
    maxTurns: 10,
    maxToolResultChars: 40_000,
    compact: { keepTurns: 1 },
    promptCache: { session: 'logs-1' },
    onCompact: (event) => void events.push(event),
  }).named('clipAgent');
}

const bytes = (value: unknown): string => JSON.stringify(value);

describe('a forced summary that would overflow', () => {
  test('goes to the summary call as text, the oldest result clipped, and the run answers', async () => {
    const run = provider();
    const events: AgentCompaction[] = [];
    const answered = await declare(events).run(INPUT, { ctx: ctx() });

    expect(answered.output).toEqual({ title: 'Logs' });
    expect(run.summaries.length).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turn: 3,
      outcome: 'compacted',
      summaryInput: 'text',
      clipped: 1,
      omitted: 0,
      summarised: 1,
      kept: 1,
    });

    const summary = run.summaries[0] ?? expect.unreachable('no summary call');
    const text = bytes(summary.messages);
    expect(text).toContain(TRANSCRIPT_NOTE);
    expect(text).toContain('HEAD-OF-LOG');
    expect(text).toContain('TAIL-OF-LOG');
    expect(text).not.toContain('MIDDLE-OF-LOG');
    // The result as the run rendered it (a JSON string, quotes included), less the two halves.
    const rendered = JSON.stringify(HUGE).length;
    expect(text).toContain(`[… ${rendered - SUMMARY_CLIP_CHARS} characters left out …]`);
  });

  test('the cached prefix and the run transcript are the bytes they were', async () => {
    const run = provider();
    await declare([]).run(INPUT, { ctx: ctx() });
    const refused = run.loop[2] ?? expect.unreachable('no refused turn');
    const resent = run.loop[3] ?? expect.unreachable('no re-send');
    const summary = run.summaries[0] ?? expect.unreachable('no summary call');

    // Tools, system and cache hint: the same value on the summary call as on the refused turn.
    expect(bytes(summary.tools)).toBe(bytes(refused.tools));
    expect(bytes(summary.system)).toBe(bytes(refused.system));
    expect(summary.promptCache).toEqual({ session: 'logs-1' });
    // The first message opens with the refused turn's first message, block for block.
    const head = refused.messages[0] ?? expect.unreachable('no head');
    const opened = summary.messages[0]?.content ?? expect.unreachable('no summary head');
    const blocks = blocksOf(head);
    expect(bytes(blocks)).toBe(
      bytes(blocksOf({ role: 'user', content: opened }).slice(0, blocks.length)),
    );
    // Clipping is the summary call's alone: the kept turn is re-sent verbatim, and the huge
    // result the provider refused was sent whole, never clipped in the run's own transcript.
    expect(bytes(resent.messages.slice(-2))).toBe(bytes(refused.messages.slice(-2)));
    expect(bytes(refused.messages)).toContain('MIDDLE-OF-LOG');
    for (const request of run.loop) expect(bytes(request.messages)).not.toContain('left out');
  });
});

describe('turns that fit the summary call whole', () => {
  test("go as the run's own messages, and the event says so — nothing clipped", async () => {
    const { summaries } = scripted([READ, READ, READ, READ, READ, READ, ANSWER]);
    const events: AgentCompaction[] = [];
    await declareSmall({ compact: { keepTurns: 2 } }, events)(INPUT, { ctx: ctx() });
    const first = events[0] ?? expect.unreachable('no compaction');
    expect(first).toMatchObject({ outcome: 'compacted', summaryInput: 'messages' });
    expect(first.clipped).toBeUndefined();
    expect(bytes(summaries[0]?.messages)).not.toContain(TRANSCRIPT_NOTE);
  });
});
