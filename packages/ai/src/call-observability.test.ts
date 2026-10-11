/**
 * What an unattended job can SEE of a model call. Two gaps first: `llm()` reported nothing per
 * call — only `agent()` had `onTurn` — so a verifier's spend was invisible until the ledger was
 * read; and the issues of a schema-repair turn (what the model was told to fix) were observable
 * nowhere, on either factory, unless the run finally failed and they surfaced in the cause.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import type { LlmCall } from './llm';
import { ANSWER, declare, install, POST_ID, promptFor, stub } from './llm-fixture';
import { useFixtureModels } from './model-fixture';
import { resetAiRuntime } from './runtime';

useFixtureModels();

beforeEach(() => {
  resetAiRuntime();
});

describe('llm() onCall', () => {
  test('one event per provider call, with its usage, cost and the running total', async () => {
    const { provider } = stub(ANSWER);
    install(provider);
    const calls: LlmCall[] = [];
    const summarize = declare(promptFor(), { onCall: (event) => void calls.push(event) });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      attempt: 1,
      model: 'claude-opus-5',
      provider: 'stub',
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 8 },
      cost: { minor: 1, currency: 'USD' },
      run: { usage: { inputTokens: 12, outputTokens: 8 } },
    });
    expect(calls[0]?.repairOf).toBeUndefined();
  });

  test('the repair call says what the model was told to fix, and the total covers both', async () => {
    const { provider } = stub({ summary: 7 }, ANSWER);
    install(provider);
    const calls: LlmCall[] = [];
    const summarize = declare(promptFor(), { onCall: (event) => void calls.push(event) });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

    expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
    expect(calls[0]?.repairOf).toBeUndefined();
    expect(calls[1]?.repairOf?.join(' ')).toContain('summary');
    expect(calls[1]?.run.usage).toMatchObject({ inputTokens: 24, outputTokens: 16 });
  });

  test('a call that then fails its schema twice still reported both — and the error lists the issues', async () => {
    const { provider } = stub({ summary: 7 });
    install(provider);
    const calls: LlmCall[] = [];
    const summarize = declare(promptFor(), { onCall: (event) => void calls.push(event) });

    const outcome = await summarize({ postId: POST_ID }, { ctx: anonymousCtx() }).catch(
      (error: unknown) => error as { code: string; meta: { issues: readonly string[] } },
    );
    expect(calls).toHaveLength(2);
    expect(outcome).toMatchObject({ code: 'X_LLM_OUTPUT_INVALID', meta: { attempts: 2 } });
    expect((outcome as { meta: { issues: readonly string[] } }).meta.issues.length).toBeGreaterThan(
      0,
    );
  });

  test('a throw from onCall fails the call: an observer that stopped working must not look fine', async () => {
    const { provider } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      onCall: () => {
        throw new TypeError('observer down');
      },
    });
    await expect(summarize({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toThrow(
      'observer down',
    );
  });
});

describe('agent() onTurn repairOf', () => {
  test('the turn after a rejected answer carries the issues; no other turn does', async () => {
    const { provider } = stub({ answer: 7 }, { answer: 'done' });
    install(provider);
    const turns: AgentTurn[] = [];
    const run = agent({
      input: t.object({ postId: t.uuid }),
      output: t.object({ answer: t.string }),
      prompt: promptFor(),
      vars: ({ input }) => ({ postId: input.postId }),
      tools: [],
      policy: allow(),
      onTurn: (event) => void turns.push(event),
    }).named('repairObserved');

    await run({ postId: POST_ID }, { ctx: anonymousCtx() });

    expect(turns).toHaveLength(2);
    expect(turns[0]?.repairOf).toBeUndefined();
    expect(turns[1]?.repairOf?.join(' ')).toContain('answer');
  });
});
