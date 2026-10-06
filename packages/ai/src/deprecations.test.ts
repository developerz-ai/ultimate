// The two pieces of vendor data the package still ships — the built-in `DEFAULT_MODEL` fallback and
// the built-in catalogue rows — each record a deprecation the first time a process leans on them,
// once per site, naming the app-side call that replaces them. Neither fix line names a vendor as
// the default: the app picks its models and its provider (M12; removed in 25.0.0).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { type LogSink, setLogSink } from '@ultimat3/core';
import { resetAiDeprecations } from './deprecations';
import { EchoProvider } from './echo-provider';
import { AiGatewayMissingError, AiRequestInvalidError } from './errors';
import { createGateway } from './gateway';
import { ANSWER, declare, POST_ID, promptFor, stub, USAGE } from './llm-fixture';
import { DEFAULT_MODEL, type ModelSpec, reasoningBody, registerModel, resetModels } from './models';
import { registerOpenAiModels } from './openai-models';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

/** A model only the app knows about: registered here, priced by its own row. */
const HOUSE: ModelSpec = {
  id: 'acme-house-1',
  contextWindow: 100_000,
  maxOutput: 8_000,
  inputPerMillion: { minor: 100, currency: 'USD' },
  outputPerMillion: { minor: 300, currency: 'USD' },
  cacheMinimumTokens: 1_024,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
};

/** Any vendor named as what to use — a deprecation's fix must leave that choice to the app. */
const VENDOR = /claude|anthropic|openai|gpt-/i;

let lines: Record<string, unknown>[] = [];
let previous: LogSink | undefined;

beforeEach(() => {
  resetAiRuntime();
  resetAiDeprecations();
  resetModels();
  registerOpenAiModels();
  lines = [];
  previous = setLogSink((line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
});

afterEach(() => {
  setLogSink(previous);
  resetModels();
  registerOpenAiModels();
});

const recorded = (kind: string): Record<string, unknown>[] =>
  lines.filter((line) => line['msg'] === 'ai.deprecation' && line['kind'] === kind);

const call = (summarize: ReturnType<typeof declare>): Promise<unknown> =>
  summarize({ postId: POST_ID }, { ctx: anonymousCtx() });

describe('resolving a model through the built-in DEFAULT_MODEL', () => {
  test('records one deprecation per site, naming createGateway({ defaultModel }) and model:', async () => {
    const { provider } = stub(ANSWER);
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const summarize = declare(promptFor());

    expect(await call(summarize)).toEqual(ANSWER);
    expect(await call(summarize)).toEqual(ANSWER);

    const found = recorded('default-model');
    expect(found).toHaveLength(1);
    expect(found[0]?.['site']).toBe('llm');
    expect(found[0]?.['model']).toBe(DEFAULT_MODEL);
    const fix = String(found[0]?.['fix']);
    expect(fix).toContain('createGateway({');
    expect(fix).toContain('defaultModel');
    expect(fix).toContain('model:');
    expect(fix).toContain('25.0.0');
    expect(fix).not.toMatch(VENDOR);
  });

  test("the gateway's defaultModel is consulted by llm(), and records nothing", async () => {
    registerModel(HOUSE);
    const { provider, seen } = stub(ANSWER);
    configureAi({
      gateway: createGateway({
        providers: [{ ...provider, models: [HOUSE.id] }],
        defaultModel: HOUSE.id,
      }),
    });

    expect(await call(declare(promptFor()))).toEqual(ANSWER);
    expect(seen[0]?.model).toBe(HOUSE.id);
    expect(recorded('default-model')).toEqual([]);
    expect(recorded('built-in-price')).toEqual([]);
  });

  test("a declaration's own model records nothing", async () => {
    registerModel(HOUSE);
    const { provider } = stub(ANSWER);
    configureAi({ gateway: createGateway({ providers: [{ ...provider, models: [HOUSE.id] }] }) });

    expect(await call(declare(promptFor(), { model: HOUSE.id }))).toEqual(ANSWER);
    expect(recorded('default-model')).toEqual([]);
  });

  test('the gateway and the echo provider are sites of their own, each recorded once', async () => {
    const gateway = createGateway({ providers: [new EchoProvider()] });
    const request = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 16 };
    await gateway.generate(request);
    await gateway.generate(request);
    await new EchoProvider().generate(request);
    await new EchoProvider().generate(request);

    expect(recorded('default-model').map((line) => line['site'])).toEqual([
      'gateway',
      'echo-provider',
    ]);
  });
});

describe('pricing a model through a built-in catalogue row', () => {
  test('records one deprecation per row, naming registerModel', () => {
    costOf(DEFAULT_MODEL, USAGE);
    costOf(DEFAULT_MODEL, USAGE);
    costOf('gpt-5.6-luna', USAGE);

    const found = recorded('built-in-price');
    expect(found.map((line) => line['model'])).toEqual([DEFAULT_MODEL, 'gpt-5.6-luna']);
    const fix = String(found[0]?.['fix']);
    expect(fix).toContain(`registerModel({ id: '${DEFAULT_MODEL}'`);
    expect(fix).toContain('25.0.0');
  });

  test('a row the app registered records nothing — a new id or a built-in id restated', () => {
    registerModel(HOUSE);
    costOf(HOUSE.id, USAGE);
    registerModel({ ...HOUSE, id: 'claude-sonnet-5' });
    costOf('claude-sonnet-5', USAGE);

    expect(recorded('built-in-price')).toEqual([]);
  });
});

describe('no fix line names a vendor as the default', () => {
  test('X_AI_GATEWAY_MISSING leaves the provider to the app', () => {
    const fix = new AiGatewayMissingError({ prompt: 'p@1' }).fix;
    expect(fix).toContain('createGateway({ providers: [yourProvider] })');
    expect(fix).not.toContain('new AnthropicProvider()');
  });

  test('a reasoning refusal does not tell the app to switch to the built-in default', () => {
    registerModel(HOUSE);
    const fixes = [
      () => reasoningBody(HOUSE.id, 'high', undefined),
      () => reasoningBody(HOUSE.id, undefined, 'adaptive'),
      () => reasoningBody('claude-opus-5-5', undefined, 'disabled'),
    ].map((run) => {
      try {
        run();
      } catch (error) {
        if (error instanceof AiRequestInvalidError) return error.fix ?? '';
      }
      return expect.unreachable('the request was not refused');
    });
    expect(fixes).toHaveLength(3);
    for (const fix of fixes) expect(fix).not.toContain(DEFAULT_MODEL);
  });
});

describe('the built-in default has one reader', () => {
  // The ONE fallback is `resolveModel`: a `?? DEFAULT_MODEL` anywhere else answers without
  // recording the deprecation, and is a second place 25.0.0 has to find.
  test('no source file outside models.ts, model-resolve.ts and the barrel reads DEFAULT_MODEL', async () => {
    const allowed = new Set(['models.ts', 'model-resolve.ts', 'index.ts']);
    const readers: string[] = [];
    for await (const file of new Bun.Glob('*.ts').scan({ cwd: import.meta.dir })) {
      if (allowed.has(file) || file.endsWith('.test.ts') || file.endsWith('-fixture.ts')) continue;
      const code = (await Bun.file(`${import.meta.dir}/${file}`).text())
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
      if (code.some((line) => /\bDEFAULT_MODEL\b/.test(line))) readers.push(file);
    }
    expect(readers).toEqual([]);
  });
});
