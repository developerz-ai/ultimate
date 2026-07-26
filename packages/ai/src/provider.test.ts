import { describe, expect, test } from 'bun:test';
import { AnthropicProvider, MODELS, parseMessage } from './provider';

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

  test('effort lives inside output_config and thinking defaults to adaptive', () => {
    const body = provider.body({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1_000,
      effort: 'xhigh',
    });
    expect(body['output_config']).toEqual({ effort: 'xhigh' });
    expect(body['effort']).toBeUndefined();
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

  test('max_tokens is clamped to the model ceiling', () => {
    const body = provider.body({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 500_000,
    });
    expect(body['max_tokens']).toBe(MODELS['claude-haiku-4-5'].maxOutput);
  });

  test('a remote call without a key throws X_NOT_IMPLEMENTED naming the env var', async () => {
    await expect(
      provider.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 }),
    ).rejects.toMatchObject({ code: 'X_NOT_IMPLEMENTED' });
  });
});

describe('response parsing', () => {
  test('a refusal is a successful response with a refusal stop reason', () => {
    const result = parseMessage('claude-opus-5', {
      content: [],
      stop_reason: 'refusal',
      usage: { input_tokens: 12, output_tokens: 0 },
    });
    // Callers must branch on stopReason before reading text — content may be empty.
    expect(result.stopReason).toBe('refusal');
    expect(result.text).toBe('');
  });

  test('text and tool_use blocks are separated, and usage drives cost', () => {
    const result = parseMessage('claude-opus-5', {
      content: [
        { type: 'text', text: 'calling a tool' },
        { type: 'tool_use', id: 'toolu_1', name: 'publishPost', input: { postId: 'p1' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1_000_000, output_tokens: 0 },
    });
    expect(result.text).toBe('calling a tool');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'publishPost', input: { postId: 'p1' } },
    ]);
    expect(result.cost).toEqual({ minor: 500, currency: 'USD' });
  });
});
