/**
 * When compaction cannot help: a summary call that answers nothing usable leaves the run whole
 * while it still fits, and a run that no longer fits is `X_AGENT_CONTEXT_EXHAUSTED` before the
 * request is sent — never a truncated transcript. Plus the declaration's own screen.
 */

import { describe, expect, test } from 'bun:test';
import { classifyThrown, isUltimateError, registerErrorRetry } from '@ultimat3/core';
import type { AgentCompaction } from './agent';
import { promptTokens } from './agent-compact';
import type { AgentCompactOption } from './agent-compact-def';
import {
  ANSWER,
  compactedHead,
  ctx,
  declare,
  INPUT,
  READ,
  ROOM,
  type SummaryReply,
  scripted,
} from './agent-compact-fixture';
import { transcriptOf } from './agent-continue';
import { billedOf } from './billed';
import { AiTransportError } from './errors';
import { AI_ERROR_RETRY } from './errors-retry';
import { useFixtureModels } from './model-fixture';

useFixtureModels();

/** Four reads: over half the room by the end, never over the room itself. */
const FOUR_READS = [READ, READ, READ, READ, ANSWER];
const EIGHT_READS = [READ, READ, READ, READ, READ, READ, READ, READ, ANSWER];

const FAILURES: readonly [string, SummaryReply, string][] = [
  ['answers no text', { text: '   ' }, 'answered no text'],
  ['answers only a tool call', { toolCalls: [{ id: 's', name: 'readDoc', input: {} }] }, 'no text'],
  ['is cut off', { text: 'SUMMARY: half', stopReason: 'max_tokens' }, 'cut off'],
  ['is refused', { text: '', stopReason: 'refusal' }, 'refused'],
  [
    'cannot reach the provider',
    { fail: new AiTransportError({ provider: 'scripted', status: 503, detail: 'overloaded' }) },
    'X_AI_PROVIDER_UNAVAILABLE',
  ],
];

describe('a failed compaction, while the request still fits', () => {
  for (const [what, reply, reason] of FAILURES) {
    test(`a summary call that ${what} leaves the run whole, and says so`, async () => {
      const { loop, summaries } = scripted(FOUR_READS, reply);
      const events: AgentCompaction[] = [];
      const answer = await declare({ compact: { at: 0.5, keepTurns: 1 } }, events)(INPUT, {
        ctx: ctx(),
      });
      expect(answer).toEqual({ title: 'Tides' });
      expect(summaries.length).toBeGreaterThan(0);
      const first = events[0] ?? expect.unreachable('no compaction attempt');
      expect(first.outcome).toBe('failed');
      expect(first.reason).toContain(reason);
      expect(first.after).toBe(first.before);
      expect(first.compactions).toBe(0);
      for (const request of loop) expect(compactedHead(request.messages[0])).toBe(false);
    });
  }
});

describe('X_AGENT_CONTEXT_EXHAUSTED', () => {
  test('a failed summary with the request over the room stops the run before the request is sent', async () => {
    const { loop, summaries } = scripted(EIGHT_READS, { text: '' });
    const events: AgentCompaction[] = [];
    const write = declare({ compact: { keepTurns: 2 } }, events);
    const error = await write.run(INPUT, { ctx: ctx() }).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'X_AGENT_CONTEXT_EXHAUSTED' });
    if (!isUltimateError(error)) return expect.unreachable('not an UltimateError');
    expect(error.fix).toContain('compact: { at: 0.6, keepTurns: 2 }');
    // Registered terminal: an `agentJob()` dead-letters it on attempt one.
    registerErrorRetry(AI_ERROR_RETRY);
    expect(classifyThrown(error)).toBe('terminal');
    expect(error.meta).toMatchObject({ limit: ROOM, reason: 'the summary call answered no text' });
    // No request over the room ever left; the one it refused is the one it measured.
    for (const request of loop) expect(promptTokens(request)).toBeLessThanOrEqual(ROOM);
    expect(Number(error.meta?.['estimate'])).toBeGreaterThan(ROOM);
    // The summary calls were billed and the handle on the error is whole, never cut.
    expect(billedOf(error)?.calls).toBe(loop.length + summaries.length);
    const handle = transcriptOf(error) ?? expect.unreachable('no handle on the error');
    expect(handle.turns).toBe(loop.length);
    expect(compactedHead(handle.messages[0])).toBe(false);
    expect(handle.messages.length).toBe(1 + 2 * loop.length);
    expect(events.at(-1)?.outcome).toBe('failed');
  });

  test('nothing older than keepTurns to summarise, and over the room: refused without a summary call', async () => {
    const { loop, summaries } = scripted(EIGHT_READS);
    const events: AgentCompaction[] = [];
    const error = await declare({ compact: { at: 1, keepTurns: 50 } }, events)(INPUT, {
      ctx: ctx(),
    }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'X_AGENT_CONTEXT_EXHAUSTED' });
    expect(String(error)).toContain('no turn older than the last 50');
    expect(summaries).toEqual([]);
    expect(events.map((event) => event.outcome)).toEqual(['failed']);
    for (const request of loop) expect(promptTokens(request)).toBeLessThanOrEqual(ROOM);
  });

  test("compact: 'off' never checks — the over-long request is sent, as before", async () => {
    const { loop } = scripted(EIGHT_READS);
    await declare({ compact: 'off' })(INPUT, { ctx: ctx() });
    expect(loop.some((request) => promptTokens(request) > ROOM)).toBe(true);
  });

  test('a throw from onCompact fails the run, as a throw from onTurn does', async () => {
    scripted(EIGHT_READS);
    const write = declare({
      compact: { keepTurns: 2 },
      onCompact: () => {
        throw new AiTransportError({ provider: 'observer', detail: 'the observer broke' });
      },
    });
    await expect(write(INPUT, { ctx: ctx() })).rejects.toThrow('the observer broke');
  });
});

describe('the declaration is screened', () => {
  const refused: readonly [string, AgentCompactOption, string][] = [
    ['at 0', { at: 0 }, 'X_AI_REQUEST_INVALID'],
    ['at over 1', { at: 1.5 }, 'X_AI_REQUEST_INVALID'],
    ['at NaN', { at: Number.NaN }, 'X_AI_REQUEST_INVALID'],
    ['keepTurns 0', { keepTurns: 0 }, 'compact.keepTurns'],
    ['maxSummaryTokens NaN', { maxSummaryTokens: Number.NaN }, 'compact.maxSummaryTokens'],
  ];
  for (const [what, compact, says] of refused) {
    test(`${what} fails the declaration`, () => {
      scripted(FOUR_READS);
      expect(() => declare({ compact })).toThrow(says);
    });
  }

  test('an unregistered summary model is X_AI_MODEL_UNKNOWN before any provider call', async () => {
    const { seen } = scripted(FOUR_READS);
    const error = await declare({ compact: { model: 'no-such-model' } })(INPUT, {
      ctx: ctx(),
    }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'X_AI_MODEL_UNKNOWN' });
    expect(seen).toEqual([]);
  });
});

describe('a failed attempt is not bought again every turn', () => {
  test('after a failure the next attempt waits until the request no longer fits', async () => {
    const { loop, summaries } = scripted([READ, READ, READ, READ, READ, ANSWER], { text: '' });
    const events: AgentCompaction[] = [];
    await declare({ compact: { at: 0.3, keepTurns: 1 } }, events)(INPUT, { ctx: ctx() });
    // Several turns over the threshold, all under the room: one attempt, one billed call.
    expect(loop.filter((request) => promptTokens(request) > 0.3 * ROOM).length).toBeGreaterThan(1);
    expect(loop.every((request) => promptTokens(request) <= ROOM)).toBe(true);
    expect(summaries.length).toBe(1);
    expect(events.map((event) => event.outcome)).toEqual(['failed']);
  });
});
