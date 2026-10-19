/**
 * What one run picks from its declaration: the tools it is offered (`offerTools()`) and the model
 * it runs on (`model` as a function). The failure first: every `agent()` read both off the
 * declaration alone, so an app that stores a per-tenant permission rule or a model tier had to
 * declare one agent per combination — or offer every tool and refuse inside each one's policy,
 * which still shows the model a tool it may never call.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { factsOf } from './agent-declared';
import {
  ANSWER,
  ctx,
  declare,
  definition,
  FREE,
  OTHER_MODEL,
  offeredIn,
  PRO,
  PUBLISH,
  READ,
  resetRuns,
  runs,
  scripted,
} from './agent-per-run-fixture';
import { FIXTURE_MODEL } from './model-fixture';

beforeEach(resetRuns);

describe('offerTools() narrows the catalogue for one run', () => {
  test('the request offers the subset, in the declared catalogue order, and respond', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({
      offerTools: ({ input }) => (input.tier === 'pro' ? ['publish', 'readDoc'] : ['readDoc']),
    });

    await write(FREE, { ctx: ctx() });
    await write(PRO, { ctx: ctx() });

    expect(offeredIn(seen[0])).toEqual(['readDoc', 'respond']);
    // The catalogue's order, not the rule's: the same subset is the same bytes, so a cache hits.
    expect(offeredIn(seen[1])).toEqual(['publish', 'readDoc', 'respond']);
  });

  test('a tool left out is not run when the model calls it anyway: it reads as unknown', async () => {
    const { seen } = scripted(PUBLISH, ANSWER);
    const write = declare({ offerTools: () => ['readDoc'] });

    expect(await write(FREE, { ctx: ctx() })).toEqual({ title: 'Tides' });

    expect(runs.publish).toBe(0);
    const answer = seen[1]?.messages.at(-1)?.content;
    expect(JSON.stringify(answer)).toContain('unknown tool: publish');
  });

  test('an empty subset offers respond alone', async () => {
    const { seen } = scripted(ANSWER);
    await declare({ offerTools: () => [] })(FREE, { ctx: ctx() });
    expect(offeredIn(seen[0])).toEqual(['respond']);
  });

  test('a name the declaration does not list is X_AGENT_TOOL_UNDECLARED before anything is loaded', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({ offerTools: () => ['readDoc', 'deleteEverything'] });

    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_TOOL_UNDECLARED',
      meta: { tools: ['deleteEverything'] },
    });
    expect(seen).toHaveLength(0);
    expect(runs.vars).toBe(0);
  });

  test('an answer that is not an array of names is X_AI_REQUEST_INVALID', async () => {
    scripted(ANSWER);
    const write = declare({ offerTools: () => 'readDoc' as unknown as readonly string[] });
    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AI_REQUEST_INVALID',
    });
  });

  test('the handle is bound to the subset: a continuation offered another one is refused', async () => {
    scripted(READ, ANSWER);
    const write = declare({
      offerTools: ({ input }) => (input.tier === 'pro' ? ['readDoc', 'publish'] : ['readDoc']),
    });
    const first = await write.run(FREE, { ctx: ctx() });

    scripted(ANSWER);
    const same = await write.continue(
      FREE,
      { transcript: first.transcript, user: 'Shorter.' },
      { ctx: ctx() },
    );
    expect(same.output).toEqual({ title: 'Tides' });

    await expect(
      write.continue(PRO, { transcript: first.transcript, user: 'Shorter.' }, { ctx: ctx() }),
    ).rejects.toMatchObject({ code: 'X_AGENT_TRANSCRIPT_INVALID' });
  });
});

describe('model may be picked per run', () => {
  test('the function reads the run, and its id is the one the request is sent on', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({
      model: ({ input }) => (input.tier === 'pro' ? OTHER_MODEL : FIXTURE_MODEL),
    });

    await write(FREE, { ctx: ctx() });
    await write(PRO, { ctx: ctx() });

    expect(seen.map((request) => request.model)).toEqual([FIXTURE_MODEL, OTHER_MODEL]);
  });

  test('undefined falls through to the prompt, then the gateway default', async () => {
    const { seen } = scripted(ANSWER);
    await declare({ model: async () => undefined })(FREE, { ctx: ctx() });
    expect(seen[0]?.model).toBe(FIXTURE_MODEL);
  });

  test('an id the app never registered is X_AI_MODEL_UNKNOWN before anything is loaded', async () => {
    const { seen } = scripted(ANSWER);
    const write = declare({ model: () => 'gpt-nobody-registered' });

    await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AI_MODEL_UNKNOWN',
    });
    expect(seen).toHaveLength(0);
    expect(runs.vars).toBe(0);
  });

  test('an answer that is not an id is X_AI_REQUEST_INVALID', async () => {
    scripted(ANSWER);
    for (const bad of ['', 42]) {
      const write = declare({ model: () => bad as string });
      await expect(write(FREE, { ctx: ctx() })).rejects.toMatchObject({
        code: 'X_AI_REQUEST_INVALID',
      });
    }
  });

  test('the handle is bound to the picked model: a continuation on another one is refused', async () => {
    scripted(ANSWER);
    const write = declare({
      model: ({ input }) => (input.tier === 'pro' ? OTHER_MODEL : FIXTURE_MODEL),
    });
    const first = await write.run(FREE, { ctx: ctx() });

    await expect(
      write.continue(PRO, { transcript: first.transcript, user: 'Again.' }, { ctx: ctx() }),
    ).rejects.toMatchObject({ code: 'X_AGENT_TRANSCRIPT_INVALID' });
  });

  test('the published fact says the model is picked per run instead of naming one', () => {
    scripted(ANSWER);
    const fact = factsOf({ ...definition(), model: () => OTHER_MODEL });
    expect(fact).toMatchObject({ model: null, modelFrom: 'run' });
    expect(factsOf(definition())).toMatchObject({ model: FIXTURE_MODEL, modelFrom: 'gateway' });
  });
});
