/**
 * A failed `.run()` / `.continue()` leaves a handle too. The failure first: a handle was only
 * written on success, so six continuations each failing `X_LLM_TRUNCATED` were billed 7,200 tokens
 * while the handle a retry resumed from still said 1,200 — `tokensPerRun` never saw them.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { transcriptOf } from './agent-continue';
import { ANSWER, ctx, declare, INPUT, model, READ, ran, resetRan } from './agent-continue-fixture';
import { billedOf } from './billed';

beforeEach(resetRan);

describe('a failed call leaves a handle that counts what it was billed', () => {
  const CUT = { call: 'respond', input: {}, stop: 'max_tokens' as const };

  test('six truncated continuations exhaust tokensPerRun when each retry uses the returned handle', async () => {
    const { seen } = model(READ, ANSWER, CUT);
    // Each call reserves ~4,100 and settles at 1,200. The run uses 2,400 of 12,000.
    const write = declare({ tokensPerRun: 12_000, maxTurns: 50 });
    let handle = (await write.run(INPUT, { ctx: ctx() })).transcript;
    const codes: string[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const outcome = await write
        .continue(INPUT, { transcript: handle, user: 'Again.' }, { ctx: ctx() })
        .catch((error: unknown) => error);
      codes.push((outcome as { code: string }).code);
      const next = transcriptOf(outcome);
      if (next === undefined) return expect.unreachable('a failed continue left no handle');
      // Every failure is on the books of the handle it returned.
      expect(billedOf(outcome)?.calls ?? 0).toBeLessThanOrEqual(1);
      handle = next;
    }
    // 2,400 + 1,200 per truncated call: the fifth leaves 5,600 − … until a reservation no longer fits.
    expect(codes.slice(0, 4)).toEqual(Array(4).fill('X_LLM_TRUNCATED'));
    expect(codes.at(-1)).toBe('X_AI_BUDGET_EXCEEDED');
    expect(handle.usage.inputTokens + handle.usage.outputTokens).toBeLessThanOrEqual(12_000);
    // And nothing was sent once the ceiling was reached.
    expect(seen.length).toBeLessThan(2 + 8);
  });

  test('the OLD handle forgets that spend — which is why a job stores the one from the error', async () => {
    model(READ, ANSWER, CUT);
    const write = declare({ tokensPerRun: 12_000, maxTurns: 50 });
    const first = (await write.run(INPUT, { ctx: ctx() })).transcript;
    const failed = await write
      .continue(INPUT, { transcript: first, user: 'Again.' }, { ctx: ctx() })
      .catch((error: unknown) => error);
    expect(transcriptOf(failed)?.usage.inputTokens).toBe(3_000);
    expect(transcriptOf(failed)?.turns).toBe(3);
    expect(first.usage.inputTokens).toBe(2_000);
  });

  test('a first run that fails after a provider answer can be resumed from its handle', async () => {
    const { seen } = model(READ, CUT, ANSWER);
    const write = declare();
    const failed = await write.run(INPUT, { ctx: ctx() }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ code: 'X_LLM_TRUNCATED' });
    const handle = transcriptOf(failed) ?? expect.unreachable('no handle');
    expect(handle.turns).toBe(2);

    const resumed = await write.continue(
      INPUT,
      { transcript: handle, user: 'Shorter.' },
      { ctx: ctx() },
    );
    expect(resumed.output).toEqual({ title: 'Tides' });
    expect(resumed.turns).toBe(3);
    // The tool result already in hand was not fetched again, and roles still alternate.
    expect(ran).toBe(1);
    expect(seen[2]?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  test('a plain call that fails leaves none: it keeps nothing', async () => {
    model(CUT);
    const failed = await declare()(INPUT, { ctx: ctx() }).catch((error: unknown) => error);
    expect(transcriptOf(failed)).toBeUndefined();
  });
});
