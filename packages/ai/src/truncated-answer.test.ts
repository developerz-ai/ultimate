/**
 * A cut-off answer is never an answer. The failure first, as an unattended job met it: a terminal
 * `respond` call stopped at the output ceiling arrives with no arguments, both wires read that as
 * `{}`, and `{}` satisfies any `output` whose keys are optional — so the run "succeeded" with
 * nothing in it, three times, each one paid for. The stop reason is read BEFORE the schema.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import type { AiFetch } from './fetch-seam';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import { definePrompt } from './prompt';
import type { Provider } from './provider';
import { anthropicProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

useFixtureModels();

const Input = t.object({ topic: t.string });
/** Every key optional — the shape `{}` slips through. */
const Output = t.object({ title: t.optional(t.string), body: t.optional(t.string) });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** What each wire sends for a `respond` call cut off before its first argument byte. */
const OPENAI_CUT = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'respond', arguments: '' } },
        ],
      },
      finish_reason: 'length',
    },
  ],
  usage: { prompt_tokens: 900, completion_tokens: 4_096 },
};
const ANTHROPIC_CUT = {
  content: [{ type: 'tool_use', id: 'toolu_1', name: 'respond', input: {} }],
  stop_reason: 'max_tokens',
  usage: { input_tokens: 900, output_tokens: 4_096 },
};

function wires(): readonly {
  readonly wire: string;
  readonly model: string;
  provider(): Provider;
}[] {
  const reply =
    (body: unknown): AiFetch =>
    () =>
      Promise.resolve(json(body));
  return [
    {
      wire: 'chat-completions',
      model: 'gpt-5.6-sol',
      provider: () =>
        openAiProvider({ apiKey: 'k', models: ['gpt-5.6-sol'], fetch: reply(OPENAI_CUT) }),
    },
    {
      wire: 'anthropic',
      model: 'claude-opus-5',
      provider: () =>
        anthropicProvider({ apiKey: 'k', models: ['claude-opus-5'], fetch: reply(ANTHROPIC_CUT) }),
    },
  ];
}

let seq = 0;
const promptFor = () => {
  seq += 1;
  return definePrompt<{ topic: string }>({
    id: `truncated-${seq}`,
    version: '1.0.0',
    template: 'Write about {{topic}}.',
  });
};

const noop: ProjectableAction = {
  name: 'readDoc',
  description: 'Read one document',
  mcp: { expose: true },
  run: () => Promise.resolve('text'),
};

beforeEach(() => {
  resetAiRuntime();
});

describe('a respond call cut off at the ceiling is X_LLM_TRUNCATED, never an empty answer', () => {
  for (const { wire, model, provider } of wires()) {
    test(`llm() over the ${wire} wire`, async () => {
      configureAi({ gateway: providerGateway({ providers: [provider()], defaultModel: model }) });
      const write = llm({
        input: Input,
        output: Output,
        prompt: promptFor(),
        vars: ({ input }) => ({ topic: input.topic }),
        policy: allow(),
      }).named(`truncatedLlm${seq}`);

      const outcome = await write({ topic: 'tides' }, { ctx: anonymousCtx() }).catch(
        (error: unknown) => error,
      );
      expect(outcome).toMatchObject({ code: 'X_LLM_TRUNCATED' });
    });

    test(`agent() over the ${wire} wire`, async () => {
      configureAi({ gateway: providerGateway({ providers: [provider()], defaultModel: model }) });
      const write = agent({
        input: Input,
        output: Output,
        prompt: promptFor(),
        vars: ({ input }) => ({ topic: input.topic }),
        tools: [noop],
        policy: allow(),
      }).named(`truncatedAgent${seq}`);

      const outcome = await write({ topic: 'tides' }, { ctx: anonymousCtx() }).catch(
        (error: unknown) => error,
      );
      expect(outcome).toMatchObject({ code: 'X_LLM_TRUNCATED' });
    });
  }
});

describe('an agent turn cut off while it was asking for a tool', () => {
  test('runs no tool: the arguments of a truncated turn are not arguments', async () => {
    let ran = 0;
    const tool: ProjectableAction = { ...noop, run: () => Promise.resolve(`ran ${++ran}`) };
    const cut = {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'readDoc', input: {} }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 4_096 },
    };
    configureAi({
      gateway: providerGateway({
        providers: [
          anthropicProvider({
            apiKey: 'k',
            models: ['claude-opus-5'],
            fetch: () => Promise.resolve(json(cut)),
          }),
        ],
        defaultModel: 'claude-opus-5',
      }),
    });
    const write = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ topic: input.topic }),
      tools: [tool],
      policy: allow(),
    }).named(`truncatedToolTurn${seq}`);

    await expect(write({ topic: 'tides' }, { ctx: anonymousCtx() })).rejects.toMatchObject({
      code: 'X_LLM_TRUNCATED',
    });
    expect(ran).toBe(0);
  });
});
