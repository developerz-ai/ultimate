// The chat providers send with their own `fetch` (streaming, in-band errors, their own retries), so
// the app-wide egress proxy reaches them through core's reader, not `outbound()`: an egress-locked
// deploy whose only way out is `outbound.proxy` must still reach the model — and a model served on
// loopback or a `direct` host (a sidecar gateway) must not be sent to the proxy.
import { afterEach, describe, expect, test } from 'bun:test';
import { configureOutboundProxy } from '@ultimat3/core/outbound';
import { anthropicProvider } from './anthropic-provider';
import type { AiFetch } from './fetch-seam';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';

useFixtureModels();

const PROXY = 'http://user:s3cret@egress.internal:3128';
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/** Every `init.proxy` the provider handed its transport, `'none'` for a call that set no key. */
function recording(reply: () => Response): { fetch: AiFetch; proxies: unknown[] } {
  const proxies: unknown[] = [];
  return {
    proxies,
    fetch: (_input, init) => {
      proxies.push('proxy' in init ? (init as { proxy?: unknown }).proxy : 'none');
      return Promise.resolve(reply());
    },
  };
}

const anthropicReply = (): Response =>
  Response.json({
    content: [{ type: 'text', text: 'hi' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 4, output_tokens: 2 },
  });
const openAiReply = (): Response =>
  Response.json({
    id: 'c-1',
    model: 'gpt-5.6-sol',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  });

async function anthropicProxy(baseUrl?: string): Promise<unknown> {
  const { fetch, proxies } = recording(anthropicReply);
  const provider = anthropicProvider({
    models: [FIXTURE_MODEL],
    apiKey: 'sk-ant-test',
    fetch,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  await provider.generate({
    model: FIXTURE_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8,
  });
  return proxies[0];
}

async function openAiProxy(baseUrl?: string): Promise<unknown> {
  const { fetch, proxies } = recording(openAiReply);
  const provider = openAiProvider({
    models: ['gpt-5.6-sol'],
    apiKey: 'sk-test',
    fetch,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  await provider.generate({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 8,
  });
  return proxies[0];
}

describe('unit · the chat providers honour the app-wide egress proxy', () => {
  test('no proxy installed: the request carries no proxy key, as before', async () => {
    expect(await anthropicProxy()).toBe('none');
    expect(await openAiProxy()).toBe('none');
  });

  test('installed: both providers send through it', async () => {
    releases.push(configureOutboundProxy({ proxy: PROXY }));
    expect(await anthropicProxy()).toBe(PROXY);
    expect(await openAiProxy()).toBe(PROXY);
  });

  test('a model on loopback or a direct host dials direct', async () => {
    releases.push(configureOutboundProxy({ proxy: PROXY, direct: ['llm-gateway.svc'] }));
    expect(await anthropicProxy('http://127.0.0.1:8080')).toBe('none');
    expect(await openAiProxy('http://llm-gateway.svc/v1')).toBe('none');
  });
});
