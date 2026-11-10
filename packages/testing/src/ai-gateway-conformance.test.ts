// The gateway suite over `providerGateway()` in front of the echo double and both recorded wires,
// and the proof it can fail: a gateway whose `scope()` runs the body and opens no ledger — every
// answer right, and every budget the app declared spending nothing.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Provider } from '@ultimat3/ai';
import { anthropicProvider, echoProvider, openAiProvider, providerGateway } from '@ultimat3/ai';
import type { Gateway } from '@ultimat3/ai/adapter';
import { secret } from '@ultimat3/core';
import {
  ANTHROPIC_MODEL,
  anthropicHello,
  OPENAI_MODEL,
  openAiHello,
  registerConformanceModels,
} from './ai-conformance-wire-fixture';
import { GATEWAY_CHECKS, gatewayConformance } from './ai-gateway-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

beforeEach(registerConformanceModels);

const over = (provider: Provider): Gateway =>
  providerGateway({ providers: [provider], sleep: () => Promise.resolve() });

describe(testName('unit', 'the provider gateway over the echo provider'), () => {
  behavesLike(gatewayConformance, () => ({
    gateway: over(echoProvider()),
    model: ANTHROPIC_MODEL,
  }));
});

describe(testName('unit', 'the provider gateway over the Anthropic wire'), () => {
  behavesLike(gatewayConformance, () => ({
    gateway: over(
      anthropicProvider({ models: [ANTHROPIC_MODEL], apiKey: 'k', fetch: anthropicHello }),
    ),
    model: ANTHROPIC_MODEL,
  }));
});

describe(testName('unit', 'the provider gateway over the OpenAI-format wire'), () => {
  behavesLike(gatewayConformance, () => ({
    gateway: over(
      openAiProvider({
        models: [OPENAI_MODEL],
        apiKey: secret('k', 'OPENAI_API_KEY'),
        fetch: openAiHello,
      }),
    ),
    model: OPENAI_MODEL,
  }));
});

/** A real gateway with the budget scope taken out. */
function unscoped(): Gateway {
  const inner = over(echoProvider());
  return {
    generate: (request) => inner.generate(request),
    stream: (request) => inner.stream(request),
    scope: (_keys, fn) => fn(),
    spent: () => inner.spent(),
    callLedger: (keys) => inner.callLedger(keys),
  };
}

const check = (prefix: string) => {
  const found = GATEWAY_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no gateway check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a gateway that breaks the contract fails conformance'), () => {
  test('a scope that opens no ledger fails both budget checks, and answers fine', async () => {
    const subject = { gateway: unscoped(), model: ANTHROPIC_MODEL };
    await check('generate answers').run(subject);
    await expect(check('outside a scope nothing is spent').run(subject)).rejects.toThrow();
    await expect(check('calls inside one scope').run(subject)).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = GATEWAY_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
