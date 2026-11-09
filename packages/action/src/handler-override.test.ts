// `overrideHandler` (`@ultimat3/action/adapter`): a test double stands where `handle` is, on every
// surface, while the policy, the input parse and the output parse still run; `undefined` restores.

import { afterEach, expect, test } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { overrideHandler } from './adapter';
import { toRoute } from './http';
import { invoke } from './invoke';

const greet = action({
  input: t.object({ who: t.string }),
  output: t.object({ text: t.string }),
  policy: allow('greet:run'),
  http: { method: 'POST', path: '/api/greet' },
  handle: ({ input }) => ({ text: `real ${input.who}` }),
}).named('greetOverride');

const guarded = action({
  input: t.object({}),
  output: t.object({ text: t.string }),
  policy: can('guarded:run'),
  handle: () => ({ text: 'real' }),
}).named('guardedOverride');

const story = action({
  input: t.object({}),
  output: t.object({ text: t.string }),
  stream: t.object({ part: t.string }),
  policy: allow('story:run'),
  async *handle() {
    yield { part: 'real' };
    return { text: 'real' };
  },
}).named('storyOverride');
const storyTwin = story.named('storyOverrideTwin');
const greetTwin = greet.named('greetOverrideTwin');

const actor = userActor({ id: 'u1' });
const as = <T>(fn: () => T): T => runWithContext(ctxOf({ actor }), fn);

afterEach(() => {
  overrideHandler(greet, undefined);
  overrideHandler(guarded, undefined);
  overrideHandler(story, undefined);
  overrideHandler(storyTwin, undefined);
  overrideHandler(greetTwin, undefined);
});

test('a direct call runs the override with the parsed input, and undefined restores', async () => {
  overrideHandler(greet, ({ input }) => ({ text: `stub ${(input as { who: string }).who}` }));
  expect(await as(() => greet({ who: 'ada' }))).toEqual({ text: 'stub ada' });
  overrideHandler(greet, undefined);
  expect(await as(() => greet({ who: 'ada' }))).toEqual({ text: 'real ada' });
});

test('the HTTP route runs the override', async () => {
  overrideHandler(greet, () => ({ text: 'over http' }));
  const server = httpServer({
    routes: [toRoute(greet)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });
  const response = await server.fetch(
    new Request('http://dev.test/api/greet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify({ who: 'ada' }),
    }),
  );
  expect(await response.json()).toEqual({ text: 'over http' });
});

test('the job surface runs the override', async () => {
  overrideHandler(greet, () => ({ text: 'in a job' }));
  expect(await as(() => invoke(greet, { who: 'ada' }, { surface: 'job' }))).toEqual({
    text: 'in a job',
  });
});

test('a stream-declaring action drains the override generator', async () => {
  overrideHandler(story, async function* () {
    yield { part: 'stub' };
    return { text: 'stub' };
  });
  expect(await as(() => story({}))).toEqual({ text: 'stub' });
  overrideHandler(story, undefined);
  expect(await as(() => story({}))).toEqual({ text: 'real' });
});

test('the policy, the input parse and the output parse still run around the override', async () => {
  overrideHandler(guarded, () => ({ text: 'never' }));
  const denied = await as(() => guarded({})).catch((error: unknown) => error);
  expect(isUltimateError(denied) && denied.code).toBe('X_FORBIDDEN');
  overrideHandler(greet, () => ({ text: 'unused' }));
  const invalid = await as(() => greet({ who: 7 } as never)).catch((error: unknown) => error);
  expect(isUltimateError(invalid) && invalid.code).toBe('X_INPUT_INVALID');
  overrideHandler(greet, () => ({ text: 42 }));
  const bad = await as(() => greet({ who: 'ada' })).catch((error: unknown) => error);
  expect(isUltimateError(bad) && bad.code).toBe('X_OUTPUT_INVALID');
});

test('an override reaches every `.named()` twin of one declaration, a stream included', async () => {
  overrideHandler(story, async function* () {
    yield { part: 'stub' };
    return { text: 'stub' };
  });
  expect(await as(() => storyTwin({}))).toEqual({ text: 'stub' });
  overrideHandler(storyTwin, undefined);
  expect(await as(() => story({}))).toEqual({ text: 'real' });
  overrideHandler(greetTwin, () => ({ text: 'twin' }));
  expect(await as(() => greet({ who: 'ada' }))).toEqual({ text: 'twin' });
});
