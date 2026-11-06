/**
 * The rows an app declares on its provider (`promptCache: { rules }`): screened at construction
 * against what the wire speaks, and — once accepted — the same bytes the module table would send
 * for the same answer, on the wire and in the budget's reservation.
 */

import { describe, expect, test } from 'bun:test';
import { BudgetLedger, withBudget } from './budget';
import { providerGateway } from './gateway';
import { openAiProvider } from './openai-provider';
import type { ProviderCacheRow } from './prompt-cache';
import {
  CHAT_REPLY,
  CLAUDE,
  capture,
  MARK,
  marks,
  NATIVE,
  openRouter,
  RUN,
  register,
  STABLE,
  transcript,
} from './prompt-cache-fixture';
import type { GenerateRequest } from './provider';
import { anthropicProvider } from './provider';

const GATEWAY = 'https://llm.internal/v1';
const PARTS: ProviderCacheRow = { model: 'anthropic/', marks: 'parts', session: 'x-session-id' };

const request: GenerateRequest = {
  model: CLAUDE,
  system: { stable: STABLE, run: RUN },
  messages: transcript,
  maxTokens: 100,
  promptCache: { session: 'kb-agent' },
};

async function viaGateway(rules: readonly ProviderCacheRow[], sent: GenerateRequest) {
  register();
  const { sent: seen, fetch } = capture(CHAT_REPLY);
  const provider = openAiProvider({
    apiKey: 'k',
    baseUrl: GATEWAY,
    models: [CLAUDE],
    promptCache: { rules },
    fetch,
  });
  await provider.generate(sent);
  return seen[0] ?? expect.unreachable('no request was sent');
}

describe('screened at construction', () => {
  const refused = (build: () => unknown, fragment: string) => {
    let thrown: unknown;
    try {
      build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(String((thrown as { cause?: unknown }).cause)).toContain(fragment);
  };
  const anthropic = (rules: unknown) => () =>
    anthropicProvider({
      models: [NATIVE],
      promptCache: { rules: rules as readonly ProviderCacheRow[] },
    });
  const openai = (rules: unknown) => () =>
    openAiProvider({ models: [CLAUDE], promptCache: { rules: rules as ProviderCacheRow[] } });

  test('a mark the wire cannot speak', () => {
    refused(anthropic([{ model: '', marks: 'parts', session: 'none' }]), 'marks "parts"');
    refused(openai([{ model: '', marks: 'blocks', session: 'none' }]), 'marks "blocks"');
    refused(openai([{ model: '', marks: 'always', session: 'none' }]), '"always"');
  });

  test('a session carrier the wire lacks', () => {
    refused(
      anthropic([{ model: '', marks: 'none', session: 'x-session-id' }]),
      'session "x-session-id"',
    );
    refused(openai([{ model: '', marks: 'none', session: 'cookie' }]), '"cookie"');
  });

  test('a row that is not a row', () => {
    refused(anthropic([{ model: 7, marks: 'none', session: 'none' }]), 'model');
    refused(anthropic('blocks'), 'rules');
    refused(openai([null]), 'row 0');
  });

  test('a row each wire speaks is accepted', () => {
    expect(anthropic([{ model: '', marks: 'none', session: 'none' }])).not.toThrow();
    expect(openai([{ model: 'x', marks: 'parts', session: 'prompt_cache_key' }])).not.toThrow();
  });
});

describe('a gateway at an unnamed host', () => {
  test('a marking row sends the bytes the table sends for OpenRouter', async () => {
    const table = await openRouter(request);
    const own = await viaGateway([PARTS], request);
    expect(own.body).toEqual(table.body);
    expect(own.headers['x-session-id']).toBe(table.headers['x-session-id']);
    expect(marks(own.body)).toBe(2);
  });

  test('with no row, the same host sends no field', async () => {
    const bare = await viaGateway([], request);
    expect(marks(bare.body)).toBe(0);
    expect(bare.headers['x-session-id']).toBeUndefined();
    expect(bare.body['prompt_cache_key']).toBeUndefined();
  });

  test('a prompt_cache_key row puts the session in the body, never a header', async () => {
    const own = await viaGateway(
      [{ model: '', marks: 'none', session: 'prompt_cache_key' }],
      request,
    );
    expect(own.body['prompt_cache_key']).toBe('kb-agent');
    expect(own.headers['x-session-id']).toBeUndefined();
    expect(marks(own.body)).toBe(0);
  });

  test('the row is resolved per request: a prefix it does not cover reaches the table', async () => {
    const own = await viaGateway([{ ...PARTS, model: 'other/' }], request);
    expect(marks(own.body)).toBe(0);
  });
});

describe('a proxy on the Messages wire', () => {
  test("a marks: 'none' row declines every mark, and the body is the unhinted one", () => {
    register();
    const proxy = anthropicProvider({
      models: [NATIVE],
      apiKey: 'k',
      baseUrl: 'https://proxy.internal',
      promptCache: { rules: [{ model: '', marks: 'none', session: 'none' }] },
    });
    const hinted = proxy.body({ ...request, model: NATIVE });
    const { promptCache: _hint, ...unhinted } = request;
    expect(marks(hinted)).toBe(0);
    expect(hinted).toEqual(proxy.body({ ...unhinted, model: NATIVE }));
    expect(proxy.marksPromptCache(NATIVE)).toBe(false);
    // The same proxy, undeclared, is the table's `blocks` row.
    const table = anthropicProvider({ models: [NATIVE], baseUrl: 'https://proxy.internal' });
    expect(marks(table.body({ ...request, model: NATIVE }))).toBe(3);
    expect(table.body({ ...request, model: NATIVE })['system']).toContainEqual({
      type: 'text',
      text: STABLE,
      cache_control: MARK,
    });
  });
});

describe('the reservation follows the row', () => {
  const reserve = async (rules: readonly ProviderCacheRow[]): Promise<number> => {
    register();
    const { fetch } = capture(CHAT_REPLY);
    const provider = openAiProvider({
      apiKey: 'k',
      baseUrl: GATEWAY,
      models: [CLAUDE],
      promptCache: { rules },
      fetch,
    });
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
        model: CLAUDE,
        messages: [{ role: 'user', content: 'x'.repeat(4_000_000) }],
        maxTokens: 1,
        promptCache: {},
      }),
    );
    return reserved[0] ?? expect.unreachable('nothing was reserved');
  };

  test('a marking row reserves the write rate; none, and no row, the input rate', async () => {
    expect(await reserve([PARTS])).toBe(376);
    expect(await reserve([{ ...PARTS, marks: 'none' }])).toBe(301);
    expect(await reserve([])).toBe(301);
  });
});
