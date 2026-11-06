/**
 * The trigger reads what the provider REPORTED. On dense JSON a provider counts about three tokens
 * where the estimate counts one; before 2026-11 the run walked past the window on the estimate and
 * met the provider's 400 at call 7. Now the reported ratio scales the estimate, and a run that
 * reports nothing compacts exactly where it always did.
 */

import { describe, expect, test } from 'bun:test';
import type { AgentCompaction } from './agent';
import { promptTokens } from './agent-compact';
import { dense, denseAgent, realTokens } from './agent-compact-dense-fixture';
import { ctx, INPUT, ROOM } from './agent-compact-fixture';
import { promptMeasure } from './agent-compact-measure';
import { useFixtureModels } from './model-fixture';
import { ZERO_USAGE } from './wire';

useFixtureModels();

const RULE = { at: 0.8, keepTurns: 2 } as const;
const TRIGGER = 0.8 * ROOM;

describe('the probe: dense tool results, a provider that reports them', () => {
  test('compacts on the measurement before any request is over the room, and answers', async () => {
    const run = dense({ reads: 20 });
    const events: AgentCompaction[] = [];
    expect(await denseAgent(RULE, events, 30)(INPUT, { ctx: ctx() })).toEqual({ title: 'Rows' });

    // The provider never had to refuse: the run compacted before it got there.
    expect(run.refused).toEqual([]);
    const first = events[0] ?? expect.unreachable('no compaction');
    expect(first.outcome).toBe('compacted');
    // The estimate alone was still under the trigger: only the measurement could have fired it.
    const plain = promptTokens(run.loop[first.turn - 2] ?? expect.unreachable('no turn'));
    expect(plain).toBeLessThan(TRIGGER);
    // `before` is the scaled figure, and it is over the trigger.
    expect(first.before).toBeGreaterThan(TRIGGER);
    for (const request of run.loop) expect(realTokens(request)).toBeLessThanOrEqual(ROOM);
  });

  test('the estimate alone would have overflowed: the same script, unreported, is refused', async () => {
    // The measurement is what saved the run above — not the overflow recovery behind it.
    const run = dense({ reads: 20, reports: 'zero' });
    await denseAgent(RULE, [])(INPUT, { ctx: ctx() }).catch(() => undefined);
    expect(run.refused.length).toBeGreaterThan(0);
  });
});

describe('a provider that reports zero', () => {
  test('compacts where the estimate says, with requests byte-identical to the unmeasured run', async () => {
    // Long enough to cross the PLAIN trigger, with every refusal disabled.
    const zero = dense({ reads: 40, reports: 'zero', refuse: () => false });
    const zeroEvents: AgentCompaction[] = [];
    await denseAgent(RULE, zeroEvents, 60)(INPUT, { ctx: ctx() });
    const first = zeroEvents[0] ?? expect.unreachable('no compaction');
    expect(first.before).toBeGreaterThan(TRIGGER);
    // Every request before it was under the plain trigger.
    for (const request of zero.loop.slice(0, first.turn - 1)) {
      expect(promptTokens(request)).toBeLessThanOrEqual(TRIGGER);
    }

    // The measured run sends the same bytes until its own first compaction.
    const real = dense({ reads: 40, refuse: () => false });
    const realEvents: AgentCompaction[] = [];
    await denseAgent(RULE, realEvents, 60)(INPUT, { ctx: ctx() });
    const measuredAt = (realEvents[0] ?? expect.unreachable('no compaction')).turn;
    expect(measuredAt).toBeLessThan(first.turn);
    const bytes = (requests: typeof real.loop, n: number): string[] =>
      requests.slice(0, n).map((request) => JSON.stringify(request.messages));
    expect(bytes(real.loop, measuredAt - 1)).toEqual(bytes(zero.loop, measuredAt - 1));
  });
});

describe('the measurement itself', () => {
  const reported = (inputTokens: number, cacheReadTokens = 0) => ({
    ...ZERO_USAGE,
    inputTokens,
    cacheReadTokens,
  });

  test('reads every input token, cached ones included, and never scales below the estimate', () => {
    const measure = promptMeasure();
    expect(measure.scale(100)).toBe(100);
    measure.observe(reported(150, 150), 100);
    expect(measure.scale(100)).toBe(300);
    measure.observe(reported(50), 100);
    expect(measure.scale(100)).toBe(100);
  });

  test('a turn that reports nothing (a cache hit, a wire with no usage) keeps the last ratio', () => {
    const measure = promptMeasure();
    measure.observe(reported(300), 100);
    measure.observe(ZERO_USAGE, 100);
    expect(measure.scale(100)).toBe(300);
  });

  test('an overflow lifts the ratio past the room, never lowers it', () => {
    const measure = promptMeasure();
    measure.overflowed(1_000, 2_500);
    expect(measure.scale(1_000)).toBe(2_501);
    measure.observe(reported(9_000), 1_000);
    measure.overflowed(1_000, 2_500);
    expect(measure.scale(1_000)).toBe(9_000);
  });
});
