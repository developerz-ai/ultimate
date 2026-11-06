/**
 * `onCheckpoint`: a signed handle between turns, so a run whose worker died resumes with
 * `.continue()` instead of re-buying every turn and re-running every tool. The resume is the
 * existing call; what this proves is that the handle exists mid-run and continues like any other.
 */

import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { stringField, UltimateError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { agent } from './agent';
import {
  ANSWER as COMPACT_ANSWER,
  READ as COMPACT_READ,
  ctx as compactCtx,
  compactedHead,
  declare as declareCompacting,
  scripted,
} from './agent-compact-fixture';
import type { AgentCheckpoint } from './agent-continue';
import * as continuation from './agent-continue';
import {
  ANSWER,
  ctx,
  INPUT,
  Input,
  model,
  Output,
  READ,
  ran,
  readDoc,
  resetRan,
  USAGE,
} from './agent-continue-fixture';
import { useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';

useFixtureModels();
beforeEach(resetRan);

let seq = 0;
function declare(
  onCheckpoint:
    | ((
        event: AgentCheckpoint,
        args: { readonly input: { topic: string } },
      ) => void | Promise<void>)
    | undefined,
  maxTurns = 8,
) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ topic: string }>({
      id: `checkpointed-${seq}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [readDoc],
    policy: allow(),
    maxTurns,
    ...(onCheckpoint === undefined ? {} : { onCheckpoint }),
  }).named(`checkpointed${seq}`);
}

/** The worker dying: nothing the loop can catch, after the app stored what it was handed. */
class WorkerDied extends UltimateError {
  constructor() {
    super({ code: 'X_TEST_WORKER_DIED', cause: 'the test killed the worker', fix: 'bun test' });
  }
}

const failed = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => expect.unreachable('the run answered'),
    (error: unknown) => error,
  );

describe('a run survives its worker', () => {
  test('resumes from the second checkpoint: earlier tools run once, the turns and bill carry on', async () => {
    const first = model(READ, READ, READ, ANSWER);
    const stored: AgentCheckpoint[] = [];
    const reviewer = declare((event) => {
      stored.push(event);
      if (event.turn === 2) throw new WorkerDied();
    });
    expect(stringField(await failed(reviewer(INPUT, { ctx: ctx() })), 'code')).toBe(
      'X_TEST_WORKER_DIED',
    );
    expect(stored.map((event) => event.turn)).toEqual([1, 2]);
    expect(first.seen.length).toBe(2);
    expect(ran).toBe(2);
    const handle = stored[1] ?? expect.unreachable('no second checkpoint');
    expect(handle.transcript.turns).toBe(2);
    expect(handle.run.usage.outputTokens).toBe(2 * USAGE.outputTokens);

    // The retry, on the same declaration: the remaining turns only — one more read, the answer.
    const second = model(READ, ANSWER);
    const resumed = await reviewer.continue(
      INPUT,
      { transcript: handle.transcript, user: 'Carry on from where you stopped.' },
      { ctx: ctx() },
    );
    expect(resumed.output).toEqual({ title: 'Tides' });
    expect(second.seen.length).toBe(2);
    expect(ran).toBe(3);
    expect(resumed.turns).toBe(4);
    expect(resumed.usage.usage.outputTokens).toBe(4 * USAGE.outputTokens);
    // The resumed run checkpoints on from where it was.
    expect(stored.map((event) => event.turn)).toEqual([1, 2, 3]);
  });

  test('maxTurns counts across the checkpoint and the resume', async () => {
    model(READ, READ);
    const stored: AgentCheckpoint[] = [];
    const reviewer = declare((event) => {
      stored.push(event);
      if (event.turn === 2) throw new WorkerDied();
    }, 3);
    await failed(reviewer(INPUT, { ctx: ctx() }));
    model(READ, ANSWER);
    const transcript = (stored[1] ?? expect.unreachable('no checkpoint')).transcript;
    const error = await failed(
      reviewer.continue(INPUT, { transcript, user: 'go on' }, { ctx: ctx() }),
    );
    expect(stringField(error, 'code')).toBe('X_AGENT_MAX_TURNS');
  });
});

describe('the hook', () => {
  test('a throw fails the run before the next turn is bought', async () => {
    const script = model(READ, ANSWER);
    const error = await failed(
      declare(() => {
        throw new WorkerDied();
      })(INPUT, { ctx: ctx() }),
    );
    expect(stringField(error, 'code')).toBe('X_TEST_WORKER_DIED');
    expect(script.seen.length).toBe(1);
  });

  test('is not called after the answer, and without it nothing is sealed', async () => {
    const seal = spyOn(continuation, 'sealTranscript');
    try {
      model(READ, ANSWER);
      await declare(undefined)(INPUT, { ctx: ctx() });
      expect(seal).not.toHaveBeenCalled();

      model(READ, ANSWER);
      const turns: number[] = [];
      await declare((event) => void turns.push(event.turn))(INPUT, { ctx: ctx() });
      expect(turns).toEqual([1]);
      expect(seal).toHaveBeenCalledTimes(1);
    } finally {
      seal.mockRestore();
    }
  });

  test("is handed the run's own input, so the app knows which row the handle belongs to", async () => {
    model(READ, ANSWER);
    const topics: string[] = [];
    await declare((_event, { input }) => void topics.push(input.topic))(INPUT, { ctx: ctx() });
    expect(topics).toEqual([INPUT.topic]);
  });

  test('an edited checkpoint is refused by the same screen as any handle', async () => {
    model(READ, ANSWER);
    const stored: AgentCheckpoint[] = [];
    const reviewer = declare((event) => void stored.push(event));
    await reviewer(INPUT, { ctx: ctx() });
    const handle = (stored[0] ?? expect.unreachable('no checkpoint')).transcript;
    const error = await failed(
      reviewer.continue(
        INPUT,
        { transcript: { ...handle, turns: 0 }, user: 'go on' },
        { ctx: ctx() },
      ),
    );
    expect(stringField(error, 'code')).toBe('X_AGENT_TRANSCRIPT_INVALID');
  });

  test('a repair turn checkpoints, and its handle carries the correction', async () => {
    model({ answer: { title: 7 } }, ANSWER);
    const stored: AgentCheckpoint[] = [];
    expect(await declare((event) => void stored.push(event))(INPUT, { ctx: ctx() })).toEqual({
      title: 'Tides',
    });
    const handle = (stored[0] ?? expect.unreachable('no checkpoint')).transcript;
    expect(stored.map((event) => event.turn)).toEqual([1]);
    expect(JSON.stringify(handle.messages.at(-1))).toContain('title');
  });
});

describe('after a compaction', () => {
  test('the next checkpoint holds the compacted messages and the signed count', async () => {
    scripted([...Array.from({ length: 7 }, () => COMPACT_READ), COMPACT_ANSWER]);
    const stored: AgentCheckpoint[] = [];
    await declareCompacting({
      compact: { keepTurns: 2 },
      onCheckpoint: (event) => void stored.push(event),
    })(INPUT, { ctx: compactCtx() });
    const after = stored.find((event) => event.transcript.compacted === 1);
    expect(compactedHead(after?.transcript.messages[0])).toBe(true);
    // Before it, every handle was the whole transcript, uncounted.
    expect(stored[0]?.transcript.compacted).toBeUndefined();
  });
});
