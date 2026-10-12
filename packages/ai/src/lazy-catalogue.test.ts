/**
 * A catalogue the app registers when its GATEWAY is first used. The failure first: 27.10 read the
 * model's row at the top of `agent()` and `llm()` — to report `llm.sampling.ignored` on the span —
 * before the gateway was asked anything, so an app whose gateway is built (and registers its
 * models) on first use had every first call refused `X_AI_MODEL_UNKNOWN`, sampling asked or not.
 * Until 27.9 the first read of the catalogue was the gateway's own. A span attribute is a report:
 * it is read once the gateway has been consulted, and never fails the call it describes.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import type { ReadableSpan } from '@ultimat3/core';
import { configureTelemetry, memoryExporter, resetTelemetry, UltimateError } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import type { Gateway } from './gateway';
import { providerGateway } from './gateway';
import { ANSWER, declare, POST_ID, promptFor, stub } from './llm-fixture';
import { FIXTURE_MODEL, registerFixtureModels } from './model-fixture';
import { resetModels } from './models';
import type { Provider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const spans = memoryExporter();

beforeEach(() => {
  resetAiRuntime();
  resetModels();
  resetTelemetry();
  spans.reset();
  configureTelemetry({ exporter: spans });
});

/** The app's shape: every method builds the real gateway on first use, and the build registers. */
function lazyGateway(provider: Provider): Gateway {
  let built: Gateway | undefined;
  const real = (): Gateway => {
    if (built === undefined) {
      registerFixtureModels();
      built = providerGateway({ providers: [provider] });
    }
    return built;
  };
  return {
    defaultModel: undefined,
    generate: (request) => real().generate(request),
    stream: (request) => real().stream(request),
    scope: (input, run) => real().scope(input, run),
    spent: () => real().spent(),
    callLedger: (keys) => real().callLedger(keys),
  };
}

const attribute = (name: string): unknown =>
  spans.spans.find((span: ReadableSpan) => span.name === name)?.attributes['llm.sampling.ignored'];

function lazyAgent(sampling: { temperature?: number; seed?: number } = {}) {
  return agent({
    input: t.object({ postId: t.uuid }),
    output: t.object({ answer: t.string }),
    prompt: promptFor(),
    model: FIXTURE_MODEL,
    vars: ({ input }) => ({ postId: input.postId }),
    tools: [],
    policy: allow(),
    ...sampling,
  });
}

describe('a catalogue registered by the gateway on first use', () => {
  test('agent(): the first call answers', async () => {
    configureAi({ gateway: lazyGateway(stub({ answer: 'done' }).provider) });
    const run = lazyAgent().named('lazyCatalogueAgent');
    expect(await run({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual({ answer: 'done' });
    expect(attribute('ai.agent')).toBe('');
  });

  test('llm(): the first call answers', async () => {
    configureAi({ gateway: lazyGateway(stub(ANSWER).provider) });
    const call = declare(promptFor(), { model: FIXTURE_MODEL });
    expect(await call({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
    expect(attribute('ai.llm')).toBe('');
  });

  test('a knob the row does not take is still reported, once the row is there', async () => {
    configureAi({ gateway: lazyGateway(stub({ answer: 'done' }).provider) });
    // The fixture rows declare no `sampling`, so both knobs are left out of the request.
    const run = lazyAgent({ temperature: 0, seed: 7 }).named('lazyCatalogueSampledAgent');
    expect(await run({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual({ answer: 'done' });
    expect(attribute('ai.agent')).toBe('temperature,seed');
  });

  test('llm() with knobs: answered, and the span names what was left out', async () => {
    configureAi({ gateway: lazyGateway(stub(ANSWER).provider) });
    const call = declare(promptFor(), { model: FIXTURE_MODEL, temperature: 0 });
    expect(await call({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual(ANSWER);
    expect(attribute('ai.llm')).toBe('temperature');
  });
});

describe('the report never changes the call it describes', () => {
  test('a gateway whose samplingWires throws: the answer stands, the attribute is left out', async () => {
    const inner = lazyGateway(stub({ answer: 'done' }).provider);
    const throwing = {
      ...inner,
      samplingWires: (): never => {
        throw new UltimateError({
          code: 'X_TEST_SAMPLING_WIRES',
          cause: 'samplingWires broke',
          fix: 'nothing: the test throws on purpose',
        });
      },
    } as Gateway;
    configureAi({ gateway: throwing });
    const run = lazyAgent({ temperature: 0 }).named('lazyCatalogueThrowingWiresAgent');
    expect(await run({ postId: POST_ID }, { ctx: anonymousCtx() })).toEqual({ answer: 'done' });
    expect(attribute('ai.agent')).toBeUndefined();
  });

  test('a failed run still reports what was left out', async () => {
    configureAi({ gateway: lazyGateway(stub({ wrong: 1 }).provider) });
    const run = lazyAgent({ seed: 7 }).named('lazyCatalogueFailingAgent');
    await expect(run({ postId: POST_ID }, { ctx: anonymousCtx() })).rejects.toBeDefined();
    expect(attribute('ai.agent')).toBe('seed');
  });

  test('a model the catalogue never names: the call keeps its own error, no attribute', async () => {
    // The call's own error is the gateway's: identity proves the report did not replace it
    // (27.10.0 read the row first and threw X_AI_MODEL_UNKNOWN before the gateway was asked).
    const own = new UltimateError({
      code: 'X_TEST_GATEWAY_REFUSED',
      cause: 'the gateway refused the call',
      fix: 'nothing: the test refuses on purpose',
    });
    const refuse = (): never => {
      throw own;
    };
    configureAi({
      gateway: {
        defaultModel: undefined,
        generate: refuse,
        stream: refuse,
        scope: refuse,
        spent: refuse,
        callLedger: refuse,
      } as unknown as Gateway,
    });
    const run = agent({
      input: t.object({ postId: t.uuid }),
      output: t.object({ answer: t.string }),
      prompt: promptFor(),
      model: 'nobody/unlisted-model',
      vars: ({ input }) => ({ postId: input.postId }),
      tools: [],
      policy: allow(),
      temperature: 0,
    }).named('lazyCatalogueUnlistedAgent');
    const error = await run({ postId: POST_ID }, { ctx: anonymousCtx() }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBe(own);
    expect(attribute('ai.agent')).toBeUndefined();
  });
});
