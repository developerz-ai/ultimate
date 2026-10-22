/**
 * Auto-compaction through the loop: when it triggers, what it keeps, what it sends, and what it
 * costs. Every number is deterministic — the scripted model answers by position, the estimate is
 * the gateway's own arithmetic, and the window is a fixture row 3,000 tokens wide.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentCompaction, AgentTurn } from './agent';
import { promptTokens } from './agent-compact';
import {
  ANSWER,
  compactedHead,
  ctx,
  DEAR,
  declare,
  INPUT,
  pairsIntact,
  promptFor,
  READ,
  ROOM,
  SMALL,
  SUMMARY,
  SUMMARY_USAGE,
  scripted,
  USAGE,
  WRITER,
} from './agent-compact-fixture';
import { useFixtureModels } from './model-fixture';
import { anthropicProvider, costOf, totalTokens } from './provider';

useFixtureModels();

const SIX_READS = [READ, READ, READ, READ, READ, READ, READ, ANSWER];
const at = (index: number, list: readonly AgentCompaction[]): AgentCompaction =>
  list[index] ?? expect.unreachable(`no compaction #${index + 1}`);

describe('the trigger', () => {
  test('compacts before the first turn estimated over `at` of the room, never earlier', async () => {
    const { loop, summaries } = scripted(SIX_READS);
    const events: AgentCompaction[] = [];
    await declare({ compact: { keepTurns: 2 } }, events)(INPUT, { ctx: ctx() });

    const first = at(0, events);
    expect(first.outcome).toBe('compacted');
    expect(first.limit).toBe(ROOM);
    expect(first.before).toBeGreaterThan(0.8 * ROOM);
    expect(first.after).toBeLessThan(first.before);
    // Every turn before it went out whole, under the threshold.
    for (const request of loop.slice(0, first.turn - 1)) {
      expect(compactedHead(request.messages[0])).toBe(false);
      expect(promptTokens(request)).toBeLessThanOrEqual(0.8 * ROOM);
    }
    // The turn it was for went out compacted, with the estimate the event reported.
    const compacted = loop[first.turn - 1] ?? expect.unreachable('no compacted turn');
    expect(compactedHead(compacted.messages[0])).toBe(true);
    expect(promptTokens(compacted)).toBe(first.after);
    expect(summaries.length).toBe(events.filter((e) => e.outcome === 'compacted').length);
    // No request the loop sent was ever over the room.
    for (const request of loop) expect(promptTokens(request)).toBeLessThanOrEqual(ROOM);
  });

  test('a summary call is not a turn: maxTurns counts the loop alone', async () => {
    const { loop, summaries } = scripted(SIX_READS);
    const turns: AgentTurn[] = [];
    const run = await declare({ compact: { keepTurns: 2 }, maxTurns: 8 }, [], turns).run(INPUT, {
      ctx: ctx(),
    });
    expect(summaries.length).toBeGreaterThan(0);
    expect(run.turns).toBe(loop.length);
    expect(turns.map((turn) => turn.turn)).toEqual(loop.map((_, index) => index + 1));
  });
});

describe('what a compaction keeps', () => {
  test('the last keepTurns turns verbatim, the prompt verbatim, and every tool call paired', async () => {
    const whole = scripted(SIX_READS);
    const prompt = promptFor('kept-verbatim');
    await declare({ compact: 'off', prompt })(INPUT, { ctx: ctx() });
    const { loop } = scripted(SIX_READS);
    const events: AgentCompaction[] = [];
    await declare({ compact: { keepTurns: 2 }, prompt }, events)(INPUT, { ctx: ctx() });

    const first = at(0, events);
    expect(first.kept).toBe(2);
    const compacted = loop[first.turn - 1]?.messages ?? expect.unreachable('no compacted turn');
    const original = whole.loop[first.turn - 1]?.messages ?? expect.unreachable('no whole turn');
    expect(first.summarised).toBe((original.length - 1) / 2 - 2);
    // One head, then exactly the last two turns — the same bytes the uncompacted run sent.
    expect(compacted.length).toBe(1 + 2 * 2);
    expect(JSON.stringify(compacted.slice(1))).toBe(JSON.stringify(original.slice(-4)));
    expect(compacted[1]?.role).toBe('assistant');
    // The head: the prompt as it was sent, then the summary, marked.
    const head = compacted[0]?.content;
    expect(head).toEqual([
      { type: 'text', text: 'Write about tides.' },
      { type: 'text', text: expect.stringContaining(SUMMARY) },
    ]);
    for (const request of loop) expect(pairsIntact(request.messages)).toBe(true);
  });

  test('a second compaction folds the first summary in, never stacks a second one', async () => {
    const { loop } = scripted([...SIX_READS.slice(0, -1), READ, READ, READ, ANSWER]);
    const events: AgentCompaction[] = [];
    const run = await declare({ compact: { keepTurns: 2 } }, events).run(INPUT, { ctx: ctx() });
    const done = events.filter((event) => event.outcome === 'compacted');
    expect(done.length).toBeGreaterThan(1);
    expect(done.map((event) => event.compactions)).toEqual(done.map((_, index) => index + 1));
    const last = loop.at(-1)?.messages[0]?.content;
    const marks = Array.isArray(last)
      ? last.filter((b) => b.type === 'text' && b.text.startsWith('[compacted:'))
      : [];
    expect(marks.length).toBe(1);
    expect(run.transcript.compacted).toBe(done.length);
  });
});

describe('the cached prefix survives', () => {
  test('system, tools and cache hint are the same value on every request, the summary call included', async () => {
    const { seen, summaries } = scripted(SIX_READS);
    await declare({ compact: { keepTurns: 2 }, promptCache: { session: 'kb-7' } })(INPUT, {
      ctx: ctx(),
    });
    expect(summaries.length).toBeGreaterThan(0);
    const [first, ...rest] = seen;
    for (const request of rest) {
      expect(JSON.stringify(request.system)).toBe(JSON.stringify(first?.system));
      expect(JSON.stringify(request.tools)).toBe(JSON.stringify(first?.tools));
      expect(request.promptCache).toEqual({ session: 'kb-7' });
    }
  });

  test('on the Anthropic wire the stable system block is the same bytes, marked, on every request', async () => {
    const { seen } = scripted(SIX_READS);
    await declare({ compact: { keepTurns: 2 } })(INPUT, { ctx: ctx() });
    const wire = anthropicProvider({ apiKey: 'k', models: [SMALL] });
    const bodies = seen.map(
      (request) =>
        wire.body(request) as {
          system: { text: string; cache_control?: unknown }[];
          tools: unknown;
        },
    );
    const stable = JSON.stringify(bodies[0]?.system[0]);
    expect(bodies[0]?.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(bodies[0]?.system[0]?.text).toBe(
      'RULES: answer from the knowledge base only.\n\nINDEX\nkb: tides',
    );
    for (const body of bodies) {
      expect(JSON.stringify(body.system[0])).toBe(stable);
      expect(JSON.stringify(body.tools)).toBe(JSON.stringify(bodies[0]?.tools));
    }
  });

  test("the summary call is the turn's own request up to the cut, plus one instruction", async () => {
    const { loop, summaries } = scripted(SIX_READS);
    const events: AgentCompaction[] = [];
    await declare({ compact: { keepTurns: 2 } }, events)(INPUT, { ctx: ctx() });
    const first = at(0, events);
    const summary = summaries[0]?.messages ?? expect.unreachable('no summary call');
    // What the loop would have sent for that turn: the previous request, its answer and results.
    const previous = loop[first.turn - 2]?.messages ?? expect.unreachable('no previous turn');
    const cut = summary.length;
    // Byte for byte up to the message the instruction joined — the prefix a turn already cached.
    expect(JSON.stringify(summary.slice(0, cut - 1))).toBe(
      JSON.stringify(previous.slice(0, cut - 1)),
    );
    const joined = summary.at(-1)?.content;
    expect(Array.isArray(joined) && joined.at(-1)?.type).toBe('text');
  });
});

describe('the summary call is billed to the run', () => {
  test('.run() usage, onTurn run totals and the ledger all count it', async () => {
    const { seen, gateway } = scripted(SIX_READS);
    const turns: AgentTurn[] = [];
    const events: AgentCompaction[] = [];
    const write = declare({ compact: { keepTurns: 2 } }, events, turns);
    const [run, spent] = await gateway.scope({}, async () => {
      const result = await write.run(INPUT, { ctx: ctx() });
      return [result, await gateway.spent()] as const;
    });
    const calls = seen.length;
    const summaries = events.filter((event) => event.outcome === 'compacted').length;
    const tokens =
      (calls - summaries) * totalTokens(USAGE) + summaries * totalTokens(SUMMARY_USAGE);
    expect(totalTokens(run.usage.usage)).toBe(tokens);
    expect(totalTokens(turns.at(-1)?.run.usage ?? expect.unreachable('no turn'))).toBe(tokens);
    expect(spent.minor).toBe(run.usage.cost.minor);
    expect(at(0, events).usage).toEqual(SUMMARY_USAGE);
    expect(at(0, events).cost).toEqual(costOf(SMALL, SUMMARY_USAGE));
  });

  test('a summary on another model is priced at its own rates and added to the run', async () => {
    const { seen, summaries } = scripted(SIX_READS);
    const run = await declare({ compact: { keepTurns: 2, model: WRITER } }).run(INPUT, {
      ctx: ctx(),
    });
    expect(summaries.map((request) => request.model)).toEqual(summaries.map(() => WRITER));
    const loopUsage = (seen.length - summaries.length) * USAGE.inputTokens;
    expect(run.usage.usage.inputTokens).toBe(
      loopUsage + summaries.length * SUMMARY_USAGE.inputTokens,
    );
    const own = costOf(SMALL, {
      ...USAGE,
      inputTokens: loopUsage,
      outputTokens: (seen.length - summaries.length) * USAGE.outputTokens,
    });
    const writer = costOf(WRITER, {
      ...SUMMARY_USAGE,
      inputTokens: summaries.length * SUMMARY_USAGE.inputTokens,
      outputTokens: summaries.length * SUMMARY_USAGE.outputTokens,
    });
    // The loop's usage priced once at its model's rates; the summaries at the writer's, added.
    expect(run.usage.cost.minor).toBe(own.minor + writer.minor);
  });

  test('costPerRun refuses the summary call pre-flight, as itself — never as a failed compaction', async () => {
    const { summaries } = scripted(SIX_READS);
    const events: AgentCompaction[] = [];
    const write = declare(
      {
        compact: { keepTurns: 2, model: DEAR },
        budget: { costPerRun: { minor: 10_000, currency: 'USD' } },
      },
      events,
    );
    const error = await write(INPUT, { ctx: ctx() }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(String(error)).toContain('"costPerRun"');
    expect(summaries.length).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("compact: 'off' is the loop as it always was", () => {
  test('no summary call, no marker, and the same handle a run under the threshold writes', async () => {
    const off = scripted(SIX_READS);
    const prompt = promptFor('identical');
    const whole = await declare({ compact: 'off', prompt }).run(INPUT, { ctx: ctx() });
    expect(off.summaries).toEqual([]);
    expect(off.seen.length).toBe(whole.turns);
    expect('compacted' in whole.transcript).toBe(false);
    expect(off.loop.some((request) => promptTokens(request) > ROOM)).toBe(true);

    const short = scripted([READ, READ, ANSWER]);
    const a = await declare({ compact: 'off', prompt }).run(INPUT, { ctx: ctx() });
    const shortAuto = scripted([READ, READ, ANSWER]);
    const b = await declare({ prompt }).run(INPUT, { ctx: ctx() });
    // The same short run with compaction on: it never triggers, so every request and the signed
    // handle are byte-identical to the run with it off.
    expect(JSON.stringify(shortAuto.seen)).toBe(JSON.stringify(short.seen));
    expect(b.transcript).toEqual(a.transcript);
    expect(shortAuto.summaries).toEqual([]);
  });
});
