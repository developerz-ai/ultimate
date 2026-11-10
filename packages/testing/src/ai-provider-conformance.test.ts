// The provider suites over `@ultimat3/ai`'s four providers — the echo and scripted doubles, and
// both wires over a fetch answering as each vendor does — and the proof they can fail: a provider
// that streams its answer twice, and one whose fetch never sees the caller's signal.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AiFetch, Provider } from '@ultimat3/ai';
import { anthropicProvider, echoProvider, openAiProvider, scriptedProvider } from '@ultimat3/ai';
import { secret } from '@ultimat3/core';
import {
  ANTHROPIC_MODEL,
  anthropicHello,
  OPENAI_MODEL,
  openAiHello,
  registerConformanceModels,
} from './ai-conformance-wire-fixture';
import { PROVIDER_CHECKS, providerConformance } from './ai-provider-conformance';
import {
  PROVIDER_TRANSPORT_CHECKS,
  providerTransportConformance,
} from './ai-provider-transport-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

beforeEach(registerConformanceModels);

const anthropicOver = (fetch: AiFetch, apiKey: string): Provider =>
  anthropicProvider({ models: [ANTHROPIC_MODEL], apiKey, fetch });
const openAiOver = (fetch: AiFetch, apiKey: string): Provider =>
  openAiProvider({ models: [OPENAI_MODEL], apiKey: secret(apiKey, 'OPENAI_API_KEY'), fetch });

describe(testName('unit', 'the echo provider'), () => {
  behavesLike(providerConformance, () => ({ provider: echoProvider(), model: ANTHROPIC_MODEL }));
});

describe(testName('unit', 'the scripted provider'), () => {
  behavesLike(providerConformance, () => ({
    provider: scriptedProvider({ turns: [{ text: 'hello world' }] }),
    model: ANTHROPIC_MODEL,
  }));
});

describe(testName('unit', 'the Anthropic provider over a recorded wire'), () => {
  behavesLike(providerConformance, () => ({
    provider: anthropicOver(anthropicHello, 'k'),
    model: ANTHROPIC_MODEL,
  }));
  behavesLike(providerTransportConformance, () => ({
    model: ANTHROPIC_MODEL,
    overHttp: anthropicOver,
  }));
});

describe(testName('unit', 'the OpenAI-format provider over a recorded wire'), () => {
  behavesLike(providerConformance, () => ({
    provider: openAiOver(openAiHello, 'k'),
    model: OPENAI_MODEL,
  }));
  behavesLike(providerTransportConformance, () => ({ model: OPENAI_MODEL, overHttp: openAiOver }));
});

/** Echo, with the `done` chunk sent twice — a consumer would book the call twice. */
function doubleDone(): Provider {
  const inner = echoProvider();
  return {
    name: 'double-done',
    get models() {
      return inner.models;
    },
    generate: (request) => inner.generate(request),
    async *stream(request) {
      const chunks = [];
      for await (const chunk of inner.stream(request)) chunks.push(chunk);
      yield* chunks;
      const done = chunks.at(-1);
      if (done !== undefined) yield done;
    },
  };
}

/** The Anthropic wire with the request's signal dropped on the way to the socket. */
const signalDropping = (fetch: AiFetch, apiKey: string): Provider =>
  anthropicOver(async (url, { signal: _dropped, ...init }) => fetch(url, init), apiKey);

const check = <T extends { readonly name: string }>(checks: readonly T[], prefix: string): T => {
  const found = checks.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a provider that breaks the contract fails conformance'), () => {
  test('a stream that ends on two done chunks fails the stream check', async () => {
    const subject = { provider: doubleDone(), model: ANTHROPIC_MODEL };
    await check(PROVIDER_CHECKS, 'generate answers').run(subject);
    await expect(check(PROVIDER_CHECKS, 'stream ends on').run(subject)).rejects.toThrow();
  });

  test('a provider that drops the signal fails the abort check', async () => {
    const subject = { model: ANTHROPIC_MODEL, overHttp: signalDropping };
    await expect(
      check(PROVIDER_TRANSPORT_CHECKS, "the caller's abort signal").run(subject),
    ).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = [...PROVIDER_CHECKS, ...PROVIDER_TRANSPORT_CHECKS].map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
