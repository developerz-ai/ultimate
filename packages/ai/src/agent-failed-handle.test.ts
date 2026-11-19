/**
 * A run that FAILS mid-turn still leaves a handle telling the truth about its tools: every result
 * that completed is in it, a call cut off in flight says its outcome is unknown, and a call that
 * never started says so — a continuation must not buy a side effect (a charge) twice.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { agent } from './agent';
import { transcriptOf } from './agent-continue';
import { ANSWER, INPUT, Input, model, Output } from './agent-continue-fixture';
import { useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { AiMessage } from './provider';
import type { ProjectableAction } from './tools';

useFixtureModels();

let seq = 0;
function declare(tools: readonly ProjectableAction[], extra: { deadlineMs?: number } = {}) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ topic: string }>({
      id: `failed-handle-${seq}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    tools,
    policy: allow(),
    maxToolConcurrency: 1,
    maxRepeatedToolCalls: 2,
    ...extra,
  }).named(`failedHandle${seq}`);
}

const tool = (name: string, run: () => Promise<unknown>): ProjectableAction => ({
  name,
  description: name,
  mcp: { expose: true },
  run,
});

const failed = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => expect.unreachable('the run answered'),
    (error: unknown) => error,
  );

/** The `tool_result` blocks of a handle's last message, by the call they answer. */
function resultsOf(messages: readonly AiMessage[]): Record<string, string> {
  const last = messages.at(-1);
  const blocks = last === undefined || typeof last.content === 'string' ? [] : last.content;
  const out: Record<string, string> = {};
  for (const block of blocks) {
    if (block.type === 'tool_result') out[block.tool_use_id] = String(block.content);
  }
  return out;
}

describe('a failed run’s handle', () => {
  test('an abort mid-batch keeps the result that completed and answers the rest as not run', async () => {
    const controller = new AbortController();
    let charged = 0;
    let shipped = 0;
    const charge = tool('charge', () => {
      charged += 1;
      controller.abort();
      return Promise.resolve('charged #1');
    });
    const ship = tool('ship', () => Promise.resolve(`shipped #${++shipped}`));
    model({ calls: [{ call: 'charge' }, { call: 'ship' }] });
    const buyer = declare([charge, ship]);
    const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });
    const error = await failed(
      buyer.run(INPUT, {
        ctx: ctxOf({ actor: userActor({ id: 'u-1' }), signal: controller.signal }),
      }),
    );
    expect(error).toMatchObject({ code: 'X_ABORTED' });
    expect([charged, shipped]).toEqual([1, 0]);
    const handle = transcriptOf(error) ?? expect.unreachable('no handle');
    const results = Object.values(resultsOf(handle.messages));
    expect(results[0]).toContain('charged #1');
    expect(results[1]).toMatch(/^Not run/);

    const second = model(ANSWER);
    const resumed = await buyer.continue(
      INPUT,
      { transcript: handle, user: 'go on' },
      { ctx: ctx() },
    );
    expect(resumed.output).toEqual({ title: 'Tides' });
    expect(charged).toBe(1);
    expect(JSON.stringify(second.seen[0]?.messages)).toContain('charged #1');
  });

  test('a call the deadline cut off in flight is answered as unknown, never as not run', async () => {
    // Never settles: the deadline is what ends the turn, with this call still in flight.
    const slow = tool('charge', () => new Promise<never>(() => {}));
    model({ call: 'charge' });
    const error = await failed(
      declare([slow], { deadlineMs: 20 }).run(INPUT, {
        ctx: ctxOf({ actor: userActor({ id: 'u-1' }) }),
      }),
    );
    expect(error).toMatchObject({ code: 'X_AGENT_DEADLINE' });
    const handle = transcriptOf(error) ?? expect.unreachable('no handle');
    const [only] = Object.values(resultsOf(handle.messages));
    expect(only).toMatch(/^Interrupted/);
    expect(only).not.toMatch(/Not run/);
  });

  test('a refused tool loop keeps the results of the turn that tripped it', async () => {
    let ran = 0;
    const read = tool('readDoc', () => {
      ran += 1;
      return Promise.resolve('same page');
    });
    model({ call: 'readDoc' }, { call: 'readDoc' });
    const error = await failed(
      declare([read]).run(INPUT, { ctx: ctxOf({ actor: userActor({ id: 'u-1' }) }) }),
    );
    expect(error).toMatchObject({ code: 'X_AGENT_TOOL_LOOP' });
    expect(ran).toBe(2);
    const handle = transcriptOf(error) ?? expect.unreachable('no handle');
    // Request, then two whole tool turns: nothing the tools answered is missing.
    expect(handle.messages.length).toBe(5);
    expect(Object.values(resultsOf(handle.messages))).toEqual(['"same page"']);
  });
});
