// The Anthropic provider's request half: what it puts on the wire, and how the gateway retries it.
// The streaming and parsing halves are `provider-stream.test.ts`.
import { describe, expect, test } from 'bun:test';
import { createGateway, isRetryable } from './gateway';
import { ANTHROPIC_MODEL_IDS, modelSpec } from './models';
import { AnthropicProvider } from './provider';
import { type Call, collect, fakeFetch } from './provider-fixture';

const provider = new AnthropicProvider();

describe('Anthropic request body', () => {
  test('never sends sampling parameters or a thinking budget', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
    });
    // All three are rejected with a 400 on every current model. Encoded, not documented.
    expect(body['temperature']).toBeUndefined();
    expect(body['top_p']).toBeUndefined();
    expect(body['top_k']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
  });

  test('effort lives inside output_config, and a control nobody asked for is omitted', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'xhigh',
    });
    expect(body['output_config']).toEqual({ effort: 'xhigh' });
    expect(body['effort']).toBeUndefined();
    // Adaptive is the server's own default, so sending the block unrequested bought nothing and
    // made a defaulted control indistinguishable on the wire from a declared one.
    expect(body['thinking']).toBeUndefined();
  });

  test('a thinking mode the caller DID ask for is sent', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      thinking: 'adaptive',
    });
    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' });
  });

  test('disabling thinking above high effort is refused locally, not by a 400', () => {
    expect(() =>
      provider.body({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1_000,
        effort: 'max',
        thinking: 'disabled',
      }),
    ).toThrow();
    const ok = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'high',
      thinking: 'disabled',
    });
    expect(ok['thinking']).toEqual({ type: 'disabled' });
  });

  test('sonnet has no cap on disabling thinking, so the opus rule is not applied to it', () => {
    // The rule is per model, and modelling it as one global rule refused a legal request.
    const body = provider.body({
      model: 'claude-sonnet-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'max',
      thinking: 'disabled',
    });
    expect(body['thinking']).toEqual({ type: 'disabled' });
    expect(body['output_config']).toEqual({ effort: 'max' });
  });

  test('a pre-4.6 model is sent neither control — both are a 400 on it', () => {
    const body = provider.body({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
    });
    expect(body['output_config']).toBeUndefined();
    expect(body['thinking']).toBeUndefined();
    expect(body['model']).toBe('claude-haiku-4-5');
  });

  test('asking a pre-4.6 model for a control it lacks is refused locally, never dropped', () => {
    // Silently dropping a declared `effort` would run at the default while the declaration
    // says otherwise — the failure nobody can see. Both refusals name the model to move to.
    for (const request of [{ effort: 'max' } as const, { thinking: 'adaptive' } as const]) {
      expect(() =>
        provider.body({
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 1_000,
          ...request,
        }),
      ).toThrow(/claude-haiku-4-5/);
    }
  });

  test('an effort nobody asked for is not sent, on any model', () => {
    // A default sent as a request is indistinguishable on the wire from a declaration that asked
    // for it, and it is a 400 on a model without the knob — so omission is the only safe shape.
    for (const model of ANTHROPIC_MODEL_IDS) {
      const body = provider.body({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1_000,
      });
      expect(body['output_config']).toBeUndefined();
    }
  });

  test('every blessed model gets a body its own spec says it accepts', () => {
    // Catalogue-driven, so a fourth model cannot be added with a body it would 400 on.
    for (const model of ANTHROPIC_MODEL_IDS) {
      const { reasoning } = modelSpec(model);
      const body = provider.body({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1_000,
        // Only ask for the control the catalogue says this model has; asking for one it lacks is
        // the refusal the test below pins, not this one.
        ...(reasoning.effort ? { effort: 'high' as const } : {}),
      });
      expect(body['output_config'] !== undefined).toBe(reasoning.effort);
      // Nothing asked for a thinking mode, so nothing is sent — on every model in the table.
      expect(body['thinking']).toBeUndefined();
      expect(body['temperature']).toBeUndefined();

      const asked = provider.body({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 1_000,
        ...(reasoning.adaptive ? { thinking: 'adaptive' as const } : {}),
      });
      expect(asked['thinking'] !== undefined).toBe(reasoning.adaptive);
    }
  });

  test('max_tokens is clamped to the model ceiling', () => {
    const body = provider.body({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500_000,
    });
    expect(body['max_tokens']).toBe(modelSpec('claude-haiku-4-5').maxOutput);
  });

  test('a remote call without a key throws X_AI_KEY_MISSING naming the env var', async () => {
    // An explicit empty key, so the result does not depend on the developer's own environment.
    const keyless = new AnthropicProvider({ apiKey: '' });
    await expect(
      keyless.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_AI_KEY_MISSING' });
    await expect(
      collect(keyless.stream({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })),
    ).rejects.toMatchObject({ code: 'X_AI_KEY_MISSING' });
  });
});

describe('transport', () => {
  test('generate posts a non-streaming body to the Messages endpoint and parses the reply', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'sk-ant-test',
      fetch: fakeFetch(calls, () =>
        Response.json({
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      ),
    });

    const result = await remote.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.headers['accept']).toBe('application/json');
    expect(calls[0]?.body['stream']).toBe(false);
    expect(result.text).toBe('hi');
    expect(result.usage.inputTokens).toBe(4);
  });

  test('a non-2xx carries its status, so the gateway can tell momentary from permanent', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () =>
        Response.json(
          { error: { type: 'rate_limit_error', message: 'slow down' } },
          { status: 429 },
        ),
      ),
    });

    const failure = await remote
      .generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE', status: 429 });
    // The provider's own words, not a generic "request failed".
    expect(String(failure)).toContain('slow down');
    expect(isRetryable(failure)).toBe(true);
  });

  test('a 400 is never retried — the same body earns the same rejection', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, () => new Response('max_tokens too large', { status: 400 })),
    });

    const failure = await remote
      .generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 })
      .catch((error: unknown) => error);

    expect(isRetryable(failure)).toBe(false);
    expect((failure as { fix: string }).fix).toContain('fix the request');
  });

  test('the gateway retries a 429 and succeeds on the attempt that lands', async () => {
    const calls: Call[] = [];
    const remote = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(calls, (_call, index) =>
        index < 2
          ? new Response('{}', { status: 429 })
          : Response.json({
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
      ),
    });
    const gateway = createGateway({ providers: [remote], sleep: async () => undefined });

    const result = await gateway.generate({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });

    expect(result.text).toBe('ok');
    expect(calls).toHaveLength(3);
  });
});
