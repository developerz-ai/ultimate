// `providerOptions`: the per-wire parameter bag is refused — unknown wire, unknown key, wrong type,
// out of range — before any request, and a screened bag reaches the body of its own wire only.

import { describe, expect, test } from 'bun:test';
import { anthropicProvider } from './anthropic-provider';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, FIXTURE_OPENAI_IDS, useFixtureModels } from './model-fixture';
import { chatCompletionBody } from './openai-body';
import type { GenerateRequest, Provider } from './provider';
import { PROVIDER_OPTION_KEYS, screenProviderOptions } from './provider-options';

useFixtureModels();

const ask = (providerOptions: unknown): GenerateRequest =>
  ({
    model: FIXTURE_MODEL,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 16,
    providerOptions,
  }) as GenerateRequest;

const refusedWith = (run: () => unknown, pattern: RegExp): void => {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(String((error as { cause?: unknown }).cause)).toMatch(pattern);
    return;
  }
  expect.unreachable('the bag was accepted');
};

describe('providerOptions screen', () => {
  test('a bag for a wire that does not exist is refused, naming the wires that do', () => {
    refusedWith(() => screenProviderOptions({ gemini: { top_p: 1 } }), /gemini.*anthropic, openai/);
  });

  test('an unknown key for that wire is refused, naming the keys it takes', () => {
    refusedWith(() => screenProviderOptions({ openai: { top_q: 1 } }), /openai\.top_q.*top_p/);
    // `top_p` is a chat-completions knob; the Messages wire does not take it.
    refusedWith(() => screenProviderOptions({ anthropic: { top_p: 1 } }), /anthropic\.top_p/);
  });

  test('a wrong type or an out-of-range number is refused', () => {
    refusedWith(() => screenProviderOptions({ openai: { top_p: '0.9' } }), /top_p.*number/);
    refusedWith(() => screenProviderOptions({ openai: { top_p: 1.5 } }), /top_p.*0 to 1/);
    refusedWith(() => screenProviderOptions({ openai: { top_p: Number.NaN } }), /top_p/);
    refusedWith(() => screenProviderOptions({ openai: { parallel_tool_calls: 1 } }), /boolean/);
    refusedWith(() => screenProviderOptions({ anthropic: { service_tier: 'turbo' } }), /auto/);
    refusedWith(
      () => screenProviderOptions({ anthropic: { metadata: { user: 'u' } } }),
      /metadata\.user\b.*user_id/,
    );
    refusedWith(() => screenProviderOptions({ openai: [] }), /object/);
    refusedWith(() => screenProviderOptions('top_p'), /object/);
  });

  test('a well-typed bag passes, and absent is nothing', () => {
    expect(() => screenProviderOptions(undefined)).not.toThrow();
    expect(() =>
      screenProviderOptions({
        openai: { top_p: 0.9, presence_penalty: -1, user: 'u-1', parallel_tool_calls: false },
        anthropic: { metadata: { user_id: 'u-1' }, service_tier: 'standard_only' },
      }),
    ).not.toThrow();
  });

  test('the key table is what the README promises', () => {
    expect(PROVIDER_OPTION_KEYS).toEqual({
      anthropic: ['metadata', 'service_tier'],
      openai: [
        'frequency_penalty',
        'parallel_tool_calls',
        'presence_penalty',
        'service_tier',
        'top_p',
        'user',
      ],
    });
  });
});

describe('providerOptions on the wire', () => {
  test('the openai bag lands in a chat-completions body; the anthropic bag does not', () => {
    const body = chatCompletionBody({
      request: {
        ...ask({ openai: { top_p: 0.5 }, anthropic: { service_tier: 'auto' } }),
        model: FIXTURE_OPENAI_IDS[0],
      },
      model: FIXTURE_OPENAI_IDS[0],
      provider: 'openai',
      stream: false,
    });
    expect(body['top_p']).toBe(0.5);
    expect(body['service_tier']).toBeUndefined();
  });

  test('the anthropic bag lands in a Messages body; the openai bag does not', () => {
    const provider = anthropicProvider({ models: [FIXTURE_MODEL], apiKey: 'k' });
    const body = provider.body(
      ask({ anthropic: { metadata: { user_id: 'u-1' } }, openai: { top_p: 0.5 } }),
    );
    expect(body['metadata']).toEqual({ user_id: 'u-1' });
    expect(body['top_p']).toBeUndefined();
  });

  test('a body builder screens its own bag: a direct provider call is refused too', () => {
    const provider = anthropicProvider({ models: [FIXTURE_MODEL], apiKey: 'k' });
    refusedWith(() => provider.body(ask({ anthropic: { top_k: 5 } })), /anthropic\.top_k/);
  });

  test('the gateway refuses a bad bag before any provider is called or anything reserved', async () => {
    let calls = 0;
    const echo = echoProvider();
    const counting: Provider = {
      name: 'counting',
      models: [FIXTURE_MODEL],
      generate: (request) => {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => {
        calls += 1;
        return echo.stream(request);
      },
    };
    const gateway = providerGateway({ providers: [counting] });
    await expect(gateway.generate(ask({ openai: { top_q: 1 } }))).rejects.toMatchObject({
      code: 'X_AI_REQUEST_INVALID',
    });
    const drain = async (): Promise<void> => {
      for await (const _chunk of gateway.stream(ask({ openai: { top_q: 1 } }))) {
        // refused on the first pull
      }
    };
    await expect(drain()).rejects.toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(calls).toBe(0);
  });

  test('the bag is part of the response cache key: a different top_p is a different answer', async () => {
    const store = new Map<string, string>();
    let calls = 0;
    const echo = echoProvider();
    const counting: Provider = {
      name: 'counting',
      models: [FIXTURE_MODEL],
      generate: (request) => {
        calls += 1;
        return echo.generate(request);
      },
      stream: (request) => echo.stream(request),
    };
    const gateway = providerGateway({
      providers: [counting],
      cache: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    });
    await gateway.generate(ask({ openai: { top_p: 0.1 } }));
    await gateway.generate(ask({ openai: { top_p: 0.9 } }));
    await gateway.generate(ask({ openai: { top_p: 0.9 } }));
    expect(calls).toBe(2);
  });
});
