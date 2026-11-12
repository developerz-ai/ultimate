// An abort is not a free call once the request left the process: the provider read the prompt and
// bills it. A call aborted after its request was sent records the prompt's estimate; one aborted
// before anything was sent gives the reservation back; a record that fails at `done` is never
// booked a second time from the running bill.

import { describe, expect, test } from 'bun:test';
import type { BudgetStore } from './budget';
import { currentBudget } from './budget';
import type { AiFetch } from './fetch-seam';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, FIXTURE_OPENAI_IDS, useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import type { GenerateRequest, Provider, StreamChunk } from './provider';
import { anthropicProvider } from './provider';
import { sseResponse } from './provider-fixture';
import { trackStreamBill } from './stream-bill';

useFixtureModels();

/** Called as a request reaches the wire: the moment a test aborts "after it was sent". */
let onFetch: () => void = () => undefined;

/** A fetch that never answers: it rejects as a real one does when the caller's signal aborts. */
const hangingFetch: AiFetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    onFetch();
  });

const PROMPT = 'p'.repeat(4_000); // ~1,000 tokens at the gateway's four characters a token

type Call = (
  gateway: ReturnType<typeof providerGateway>,
  request: GenerateRequest,
) => Promise<void>;

const generate: Call = async (gateway, request) => {
  await gateway.generate(request);
};
const stream: Call = async (gateway, request) => {
  for await (const _chunk of gateway.stream(request)) {
    // drained
  }
};

/** What the scope's ledger was debited after `call` ran, `arm` having set when it aborts. */
async function spentAfter(
  provider: Provider,
  model: string,
  call: Call,
  arm: (controller: AbortController) => void,
): Promise<{ tokens: number; minor: number }> {
  const gateway = providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] });
  const controller = new AbortController();
  return gateway.scope({}, async () => {
    const request = {
      model,
      messages: [{ role: 'user' as const, content: PROMPT }],
      maxTokens: 4_000,
      signal: controller.signal,
    };
    arm(controller);
    await call(gateway, request).catch(() => undefined);
    const report = await currentBudget()?.report();
    return { tokens: report?.requestTokens ?? -1, minor: report?.costExact.minor ?? -1 };
  });
}

const PROVIDERS: readonly (readonly [string, string, () => Provider])[] = [
  [
    'Anthropic',
    FIXTURE_MODEL,
    () => anthropicProvider({ models: [FIXTURE_MODEL], apiKey: 'k', fetch: hangingFetch }),
  ],
  [
    'OpenAI-format',
    FIXTURE_OPENAI_IDS[0],
    () => openAiProvider({ models: [FIXTURE_OPENAI_IDS[0]], apiKey: 'k', fetch: hangingFetch }),
  ],
];

for (const [name, model, provider] of PROVIDERS) {
  describe(`${name}: an aborted call`, () => {
    for (const [label, call] of [
      ['generate', generate],
      ['stream', stream],
    ] as const) {
      test(`${label}, aborted after the request was sent, records the prompt`, async () => {
        // Aborted once the request reached the wire, unanswered.
        const spent = await spentAfter(provider(), model, call, (controller) => {
          onFetch = () => controller.abort();
        });
        onFetch = () => undefined;
        expect(spent.tokens).toBe(1_000);
        expect(spent.minor).toBeGreaterThan(0);
      });

      test(`${label}, aborted before anything was sent, is released`, async () => {
        const controller = new AbortController();
        controller.abort();
        const gateway = providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider()] });
        const before = await gateway.scope({}, async () => {
          await call(gateway, {
            model,
            messages: [{ role: 'user', content: PROMPT }],
            maxTokens: 4_000,
            signal: controller.signal,
          }).catch(() => undefined);
          return (await currentBudget()?.report())?.requestTokens ?? -1;
        });
        expect(before).toBe(0);
      });
    }
  });
}

describe('a ledger that fails to record at done', () => {
  test('is never booked again from the running bill', async () => {
    const counters = new Map<string, number>();
    let failNextAdd = false;
    const store: BudgetStore = {
      spent: (key) => counters.get(key) ?? 0,
      add(key, tokens) {
        if (failNextAdd) {
          failNextAdd = false;
          // Handed TO the subject, never this test's own verdict.
          return Promise.reject(new RangeError('budget store unavailable'));
        }
        counters.set(key, (counters.get(key) ?? 0) + tokens);
        return undefined;
      },
      take(key, tokens, limit) {
        const spent = counters.get(key) ?? 0;
        if (spent + tokens > limit) return { taken: false, spent };
        counters.set(key, spent + tokens);
        return { taken: true, spent };
      },
      reset: () => counters.clear(),
    };
    const inner = anthropicProvider({
      models: [FIXTURE_MODEL],
      apiKey: 'k',
      fetch: async () =>
        sseResponse([
          {
            type: 'message_start',
            message: { id: 'm', usage: { input_tokens: 700, output_tokens: 1 } },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 30 },
          },
          { type: 'message_stop' },
        ]),
    });
    const flaky: Provider = {
      name: 'flaky-store',
      models: [FIXTURE_MODEL],
      generate: (request) => inner.generate(request),
      async *stream(request): AsyncIterable<StreamChunk> {
        for await (const chunk of inner.stream(request)) {
          // The running bill is there to be (wrongly) re-read: 700 + 30.
          trackStreamBill(request, () => ({
            usage: { inputTokens: 700, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
            cost: { minor: 1, currency: 'USD' },
            calls: 1,
            unsettled: 0,
          }));
          if (chunk.type === 'done') failNextAdd = true;
          yield chunk;
        }
      },
    };
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [flaky],
      budget: { org: 50_000 },
      budgetStore: store,
    });
    await gateway
      .scope({ orgKey: 'org:acme' }, async () => {
        for await (const _chunk of gateway.stream({
          messages: [{ role: 'user', content: 'hello' }],
          maxTokens: 64,
        })) {
          // drain to `done`
        }
      })
      .catch(() => undefined);
    // Never 730 on top of what the failed record left: the running bill is not a second record.
    expect(counters.get('org:acme') ?? 0).toBeLessThanOrEqual(0);
  });
});
