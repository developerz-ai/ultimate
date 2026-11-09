// `agent()` streamed over its own route: each turn's facts arrive as `chunk` frames before the
// `done` that carries the answer, across two turns and a tool. A budget still refuses.

import { describe, expect, test } from 'bun:test';
import { toRoute } from '@ultimat3/action';
import { userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { streamOf } from './agent-stream';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import { installAiGateway, resetAiRuntime } from './runtime';
import { scriptedProvider } from './scripted-provider';
import type { ProjectableAction } from './tools';

useFixtureModels();

const lookup: ProjectableAction = {
  name: 'lookup',
  description: 'look an order up',
  mcp: { expose: true },
  run: () => Promise.resolve('shipped'),
};

function support(name: string) {
  return agent({
    input: t.object({ orderId: t.string }),
    output: t.object({ answer: t.string }),
    prompt: definePrompt<{ orderId: string }>({
      id: `stream-${name}`,
      version: '1.0.0',
      template: 'Resolve {{orderId}}.',
    }),
    vars: ({ input }) => ({ orderId: input.orderId }),
    tools: [lookup],
    maxTurns: 4,
    policy: allow(),
  }).named(name);
}

const post = (target: ReturnType<typeof support>) =>
  httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => userActor({ id: 'u1' }) },
  }).fetch(
    new Request(`http://dev.test${toRoute(target).path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://dev.test',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ orderId: 'o-1' }),
    }),
  );

const framesOf = (text: string) =>
  text
    .split('\n\n')
    .filter((frame) => frame.startsWith('event:'))
    .map((frame) => {
      const [event, data] = frame.split('\n');
      return { event: event?.slice(7), data: JSON.parse(data?.slice(6) ?? 'null') as unknown };
    });

describe('agent() on the wire', () => {
  test('two turns and a tool stream as chunks, then one done with the answer', async () => {
    resetAiRuntime();
    installAiGateway(
      providerGateway({
        defaultModel: FIXTURE_MODEL,
        providers: [
          scriptedProvider({
            turns: [
              { calls: [{ call: 'lookup', input: {} }] },
              { answer: { answer: 'it shipped' } },
            ],
          }),
        ],
      }),
    );
    const response = await post(support('streamedSupport'));
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    const frames = framesOf(await response.text());
    expect(frames.map((frame) => frame.event)).toEqual(['chunk', 'chunk', 'chunk', 'done']);
    expect(frames[0]?.data).toMatchObject({ type: 'tool_call', turn: 1, name: 'lookup' });
    expect(frames[1]?.data).toMatchObject({
      type: 'tool_result',
      turn: 1,
      name: 'lookup',
      isError: false,
    });
    expect(frames[2]?.data).toEqual({ type: 'turn', turn: 1, maxTurns: 4 });
    expect(frames[3]?.data).toEqual({ answer: 'it shipped' });
  });

  test('a run that fails mid-stream ends with one error frame carrying its code', async () => {
    resetAiRuntime();
    installAiGateway(
      providerGateway({
        defaultModel: FIXTURE_MODEL,
        // The script runs out after the tool turn: the second turn is refused.
        providers: [scriptedProvider({ turns: [{ calls: [{ call: 'lookup', input: {} }] }] })],
      }),
    );
    const frames = framesOf(await (await post(support('failingSupport'))).text());
    expect(frames.at(-1)?.event).toBe('error');
    expect(frames.filter((frame) => frame.event === 'done')).toHaveLength(0);
  });

  test('streamOf yields chunks before the run settles, in order', async () => {
    let finish: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const stream = streamOf(async (emit) => {
      emit({ type: 'turn', turn: 1, maxTurns: 2 });
      return gate;
    });
    const first = await stream.next();
    expect(first).toEqual({ done: false, value: { type: 'turn', turn: 1, maxTurns: 2 } });
    finish('answer');
    expect(await stream.next()).toEqual({ done: true, value: 'answer' });
  });
});
