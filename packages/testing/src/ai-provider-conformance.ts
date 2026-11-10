// `@ultimat3/ai`'s `Provider` contract as shared examples: `behavesLike(providerConformance, () =>
// ({ provider, model }))` — `model` registered and listed, answered with an ordinary text turn.
// What it answers is the provider's; the SHAPE is the port's. HTTP: `providerTransportConformance`.

import { expect, test } from 'bun:test';
import type { ModelId, Provider } from '@ultimat3/ai';
import { isUltimateError } from '@ultimat3/core';
import { askOf, drained, expectStreamed, expectWellFormed } from './ai-conformance-answer';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface ProviderSubject {
  readonly provider: Provider;
  readonly model: ModelId;
}

export interface ProviderCheck {
  readonly name: string;
  run(subject: ProviderSubject): Promise<void>;
}

const failureOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    () => 'answered',
    (error: unknown) => error,
  );

export const PROVIDER_CHECKS: readonly ProviderCheck[] = [
  {
    name: 'it has a name and lists the model it serves',
    async run({ provider, model }) {
      expect(provider.name.length).toBeGreaterThan(0);
      expect(provider.models).toContain(model);
    },
  },
  {
    name: 'generate answers a well-formed result for the model it was asked',
    async run({ provider, model }) {
      expectWellFormed(await provider.generate(askOf(model)), model);
    },
  },
  {
    name: 'stream ends on exactly one done chunk, whose text the deltas before it spell',
    async run({ provider, model }) {
      expectStreamed(await drained(provider.stream(askOf(model))), model);
    },
  },
  {
    name: 'a request naming no model is refused X_AI_MODEL_UNRESOLVED — a provider picks none',
    async run({ provider }) {
      const request = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 16 };
      const refused = await failureOf(provider.generate(request));
      expect(isUltimateError(refused) ? refused.code : String(refused)).toBe(
        'X_AI_MODEL_UNRESOLVED',
      );
    },
  },
];

export const providerConformance: SharedExamples<ProviderSubject> = sharedExamples(
  'an AI provider',
  (subject) => {
    for (const check of PROVIDER_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
