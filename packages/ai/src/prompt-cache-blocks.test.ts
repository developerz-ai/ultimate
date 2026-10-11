/**
 * The Anthropic Messages wire's cache marks — where they go, where they never go, and that they
 * never make a fifth — and what the pre-flight estimate charges for a request that will be marked.
 */

import { describe, expect, test } from 'bun:test';
import { BudgetLedger, withBudget } from './budget';
import { providerGateway } from './gateway';
import { registerModel } from './models';
import { openAiProvider } from './openai-provider';
import {
  CHAT_REPLY,
  CLAUDE,
  capture,
  GEMINI,
  MARK,
  marks,
  NATIVE,
  ROW,
  RUN,
  register,
  STABLE,
  transcript,
  usd,
} from './prompt-cache-fixture';
import type { GenerateRequest } from './provider';
import { anthropicProvider, estimateCost } from './provider';

describe('Anthropic Messages wire', () => {
  const provider = () => {
    register();
    return anthropicProvider({ models: [NATIVE], apiKey: 'k' });
  };

  test('the stable system block and the last block of the last two messages; three marks', () => {
    const body = provider().body({
      model: NATIVE,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 100,
      promptCache: { session: 'ignored-here' },
    });
    expect(body['system']).toEqual([
      { type: 'text', text: STABLE, cache_control: MARK },
      { type: 'text', text: RUN },
    ]);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Resolve order 7.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'lookup',
            input: { id: '7' },
            cache_control: MARK,
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'shipped', cache_control: MARK },
        ],
      },
    ]);
    expect(marks(body)).toBe(3);
  });

  test('a one-message request marks it once; a string message becomes one marked block', () => {
    const body = provider().body({
      model: NATIVE,
      system: STABLE,
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['system']).toEqual([{ type: 'text', text: STABLE, cache_control: MARK }]);
    expect(body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: MARK }] },
    ]);
    expect(marks(body)).toBe(2);
  });

  test('no hint: a string system stays a string, two parts are two unmarked blocks', () => {
    const plain = provider().body({
      model: NATIVE,
      system: STABLE,
      messages: transcript,
      maxTokens: 9,
    });
    expect(plain['system']).toBe(STABLE);
    expect(marks(plain)).toBe(0);
    const parts = provider().body({
      model: NATIVE,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 9,
    });
    expect(parts['system']).toEqual([
      { type: 'text', text: STABLE },
      { type: 'text', text: RUN },
    ]);
    expect(marks(parts)).toBe(0);
  });

  test('the mark never lands on an empty or whitespace-only text block: the nearest earlier block takes it', () => {
    const body = provider().body({
      model: NATIVE,
      system: '   \n ',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'question' },
            { type: 'text', text: '' },
          ],
        },
        { role: 'assistant', content: '  ' },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c', content: 'r' },
            { type: 'text', text: ' \n' },
          ],
        },
      ],
      maxTokens: 100,
      promptCache: {},
    });
    const sent = body['messages'] as { content: unknown }[];
    // The whitespace-only string message is skipped outright; the tail's mark moves back one block.
    expect(sent[1]?.content).toBe('  ');
    expect(sent[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c', content: 'r', cache_control: MARK },
      { type: 'text', text: ' \n' },
    ]);
    expect(sent[0]?.content).toEqual([
      { type: 'text', text: 'question' },
      { type: 'text', text: '' },
    ]);
    // A whitespace-only system is not marked.
    expect(JSON.stringify(body['system'])).not.toContain('cache_control');
    expect(marks(body)).toBe(1);
  });

  test('marks a raw caller already placed count against the four: ours are dropped first', () => {
    const own = { type: 'text', text: 'pinned', cache_control: MARK } as never;
    const withOwn = (count: number): Record<string, unknown> =>
      provider().body({
        model: NATIVE,
        system: STABLE,
        messages: [
          { role: 'user', content: Array.from({ length: count }, () => own) },
          { role: 'assistant', content: 'thinking' },
          { role: 'user', content: 'go on' },
        ],
        maxTokens: 100,
        promptCache: {},
      });
    // 1 theirs + 3 ours = 4. 2 theirs: the second-to-last message gives its mark up first.
    expect(marks(withOwn(1))).toBe(4);
    const two = withOwn(2);
    expect(marks(two)).toBe(4);
    expect((two['messages'] as { content: unknown }[])[1]?.content).toBe('thinking');
    // 3 theirs: then the system block's; the tail keeps the one that is left.
    const three = withOwn(3);
    expect(marks(three)).toBe(4);
    expect(three['system']).toBe(STABLE);
    // 4 theirs: none of ours.
    const four = withOwn(4);
    expect(marks(four)).toBe(4);
    expect((four['messages'] as { content: unknown }[])[2]?.content).toBe('go on');
  });

  test('an empty stable part is never sent as an empty block, and never marked', () => {
    const body = provider().body({
      model: NATIVE,
      system: { stable: '', run: RUN },
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['system']).toEqual([{ type: 'text', text: RUN }]);
    expect(marks(body)).toBe(1);
  });
});

describe('the pre-flight estimate', () => {
  test('a hinted request is priced as a cache WRITE, the dearest the prompt can be billed', () => {
    register();
    const text = 'x'.repeat(4_000_000);
    const request: GenerateRequest = {
      model: NATIVE,
      messages: [{ role: 'user', content: text }],
      maxTokens: 1,
    };
    const hinted: GenerateRequest = { ...request, promptCache: {} };
    // 1M tokens at 300 minor; the single output token rounds up to one minor unit.
    expect(estimateCost(request).minor).toBe(301);
    // A hint alone changes nothing: the price moves only when a provider WOULD mark this request.
    expect(estimateCost(hinted).minor).toBe(301);
    expect(estimateCost(request, true).minor).toBe(301);
    // …and then it is 1.25x.
    expect(estimateCost(hinted, true).minor).toBe(376);
  });

  test('a row whose write is cheaper than input is still priced at the input rate', () => {
    register();
    registerModel({ id: NATIVE, ...ROW, cacheWritePerMillion: usd(0) });
    const request: GenerateRequest = {
      model: NATIVE,
      messages: [{ role: 'user', content: 'x'.repeat(4_000_000) }],
      maxTokens: 1,
      promptCache: {},
    };
    // Priced at the write rate alone this was 1: a `costPerCall` ceiling that passes everything.
    expect(estimateCost(request, true).minor).toBe(301);
  });

  test('the gateway prices the write only where a provider would mark: not Gemini, not an unknown host', async () => {
    register();
    const { fetch } = capture(CHAT_REPLY);
    const text = 'x'.repeat(4_000_000);
    const reserve = async (model: string, baseUrl: string): Promise<number> => {
      const provider = openAiProvider({ apiKey: 'k', baseUrl, models: [CLAUDE, GEMINI], fetch });
      const gateway = providerGateway({ providers: [provider] });
      const ledger = new BudgetLedger({ limits: {} });
      const reserved: number[] = [];
      const original = ledger.reserve.bind(ledger);
      ledger.reserve = (estimate) => {
        reserved.push(estimate.cost.minor);
        return original(estimate);
      };
      await withBudget(ledger, () =>
        gateway.generate({
          model,
          messages: [{ role: 'user', content: text }],
          maxTokens: 1,
          promptCache: {},
        }),
      );
      return reserved[0] ?? expect.unreachable('nothing was reserved');
    };
    expect(await reserve(CLAUDE, 'https://openrouter.ai/api/v1')).toBe(376);
    expect(await reserve(GEMINI, 'https://openrouter.ai/api/v1')).toBe(301);
    expect(await reserve(CLAUDE, 'https://llm.acme.internal/v1')).toBe(301);
  });
});
