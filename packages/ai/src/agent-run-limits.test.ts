/**
 * The ceilings one run runs under: `limits()` may LOWER a declared one and never raise it, and
 * `budget.costPerRun` holds the whole run's money, checked before each turn. The failure first:
 * a run's bounds were the declaration's alone, so a cheaper tier or a stored override needed its
 * own declared agent — and nothing at all capped what a whole run cost, only each call.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ANSWER,
  ctx,
  declare,
  FREE,
  READ,
  resetRuns,
  runs,
  scripted,
} from './agent-per-run-fixture';
import { billedOf } from './billed';
import { asyncRefusal } from './bounds-fixture';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL } from './model-fixture';
import type { GenerateRequest } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

beforeEach(resetRuns);

const usd = (minor: number) => ({ minor, currency: 'USD' });

describe('limits() lowers the declared ceilings for one run', () => {
  test('a lower maxTurns stops the run there', async () => {
    const { seen } = scripted(READ);
    const write = declare({ maxTurns: 6, limits: () => ({ maxTurns: 2 }) });

    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_MAX_TURNS',
    });
    expect(seen).toHaveLength(2);
  });

  test('it reads the run: one tier is bounded, another keeps the declaration', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({
      maxTokens: 2_000,
      limits: ({ input }) => (input.tier === 'free' ? { maxTokens: 500 } : {}),
    });

    await write(FREE, { ctx: ctx() });
    await write({ ...FREE, tier: 'pro' }, { ctx: ctx() });

    expect(seen.map((request) => request.maxTokens)).toEqual([500, 2_000]);
  });

  test('a higher value is X_AI_REQUEST_INVALID naming the key, before anything is loaded', async () => {
    const { seen } = scripted(ANSWER);
    for (const limits of [
      { maxTurns: 9 },
      { maxTokens: 5_000 },
      { budget: { tokensPerRun: 200_000 } },
      { budget: { costPerRun: usd(500) } },
    ]) {
      const write = declare({
        maxTurns: 8,
        maxTokens: 4_096,
        budget: { tokensPerRun: 100_000, costPerRun: usd(100) },
        limits: () => limits,
      });
      const error = await asyncRefusal(() => write(FREE, { ctx: ctx() }));
      expect(error.code).toBe('X_AI_REQUEST_INVALID');
      expect(error.cause).toContain(Object.keys(limits)[0] ?? '');
    }
    expect(seen).toHaveLength(0);
    expect(runs.vars).toBe(0);
  });

  test('a value that is not a count is refused under the key limits() wrote', async () => {
    scripted(ANSWER);
    for (const bad of [Number.NaN, 0, 2.5]) {
      const write = declare({ limits: () => ({ maxTurns: bad }) });
      const error = await asyncRefusal(() => write(FREE, { ctx: ctx() }));
      expect(error.cause).toContain('limits().maxTurns');
    }
    const loops = declare({ limits: () => ({ maxRepeatedToolCalls: 1 }) });
    expect((await asyncRefusal(() => loops(FREE, { ctx: ctx() }))).code).toBe(
      'X_AI_REQUEST_INVALID',
    );
  });

  test('a ceiling the declaration leaves unset may be set by a run: a deadline', async () => {
    const seen: GenerateRequest[] = [];
    resetAiRuntime();
    configureAi({
      gateway: providerGateway({
        defaultModel: FIXTURE_MODEL,
        providers: [
          {
            name: 'hung',
            models: [FIXTURE_MODEL],
            generate(request) {
              seen.push(request);
              // Answers nothing until the run's own signal gives up on it.
              return new Promise((_, reject) =>
                request.signal?.addEventListener('abort', () => reject(request.signal?.reason)),
              );
            },
            stream: (request) => echoProvider().stream(request),
          },
        ],
      }),
    });
    const write = declare({ limits: () => ({ deadlineMs: 30 }) });

    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_DEADLINE',
      meta: { deadlineMs: 30 },
    });
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  test('a lower tokensPerRun is the run ceiling the ledger refuses at', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({ limits: () => ({ budget: { tokensPerRun: 10 } }) });
    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen).toHaveLength(0);
  });
});

describe('budget.costPerRun holds the whole run', () => {
  // Each scripted turn costs exactly 1 cent; one turn's worst-case estimate (a short prompt, a
  // 100-token completion ceiling) is well under one.
  test('a turn the run can no longer afford is refused before the provider is called', async () => {
    const { seen } = scripted(READ, ANSWER);
    const write = declare({ maxTokens: 100, budget: { costPerRun: usd(1) } });

    const error = await asyncRefusal(() => write(FREE, { ctx: ctx() }));

    expect(error.code).toBe('X_AI_BUDGET_EXCEEDED');
    expect(error.cause).toContain('"costPerRun"');
    // The first turn ran and was billed; the second was never sent.
    expect(seen).toHaveLength(1);
    expect(billedOf(error)?.calls).toBe(1);
  });

  test('a run under its ceiling answers', async () => {
    const { seen } = scripted(READ, ANSWER);
    const write = declare({ maxTokens: 100, budget: { costPerRun: usd(3) } });
    expect(await write(FREE, { ctx: ctx() })).toEqual({ title: 'Tides' });
    expect(seen).toHaveLength(2);
  });

  test('the worst case counts: a ceiling under one turn estimate refuses the first turn', async () => {
    const { seen } = scripted(ANSWER);
    // 4,096 completion tokens at $25/M is over a cent before the model says a word.
    const write = declare({ budget: { costPerRun: usd(1) } });
    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen).toHaveLength(0);
  });

  test('continuations count: what the handle already cost is spent', async () => {
    scripted(READ, ANSWER);
    const write = declare({ maxTokens: 100, budget: { costPerRun: usd(2) } });
    const first = await write.run(FREE, { ctx: ctx() });
    expect(first.usage.cost).toEqual(usd(2));

    const { seen } = scripted(ANSWER);
    await expect(
      write.continue(FREE, { transcript: first.transcript, user: 'Again.' }, { ctx: ctx() }),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(seen).toHaveLength(0);
  });

  test('limits() may set or lower it per run', async () => {
    const { seen } = scripted(READ, ANSWER);
    const write = declare({
      maxTokens: 100,
      budget: { costPerRun: usd(5) },
      limits: () => ({ budget: { costPerRun: usd(1) } }),
    });
    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen).toHaveLength(1);
  });

  test('a declared one that is not money is refused before anything is loaded', async () => {
    scripted(ANSWER);
    const write = declare({ budget: { costPerRun: usd(Number.NaN) } });
    const error = await asyncRefusal(() => write(FREE, { ctx: ctx() }));
    expect(error.cause).toContain('budget.costPerRun.minor');
    expect(runs.vars).toBe(0);
  });
});
