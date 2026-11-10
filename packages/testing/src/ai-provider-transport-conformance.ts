// The socket half of the `Provider` contract, over `@ultimat3/ai`'s `AiFetch` seam:
// `behavesLike(providerTransportConformance, () => ({ model, overHttp }))`. Lifted from
// `ai/src/provider-parity*.test.ts`: the abort reaches the socket, an echoed key never leaves it, an
// endless error body ends, an overflow is its own code. Error bodies are `{ error: { message } }`.

import { expect, test } from 'bun:test';
import type { AiFetch, GenerateRequest, ModelId, Provider } from '@ultimat3/ai';
import { isUltimateError } from '@ultimat3/core';
import { askOf, drained } from './ai-conformance-answer';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface ProviderTransportSubject {
  readonly model: ModelId;
  /** The provider under test, every request sent through `fetch`, authenticated with `apiKey`. */
  overHttp(fetch: AiFetch, apiKey: string): Provider;
}

export interface ProviderTransportCheck {
  readonly name: string;
  run(subject: ProviderTransportSubject): Promise<void>;
}

const KEY = 'sk-live-do-not-log-me';
const OVERFLOWS = [
  'prompt is too long: 210000 tokens > 200000 maximum',
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens.",
];

const answering =
  (status: number, message: string): AiFetch =>
  async () =>
    new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

/** Both calls the port has, each settled to what it threw. */
function bothPaths(provider: Provider, request: GenerateRequest): Promise<unknown>[] {
  return [provider.generate(request), drained(provider.stream(request))].map((pending) =>
    pending.then(
      () => 'answered',
      (error: unknown) => error,
    ),
  );
}

const codeOf = (error: unknown): string =>
  isUltimateError(error) ? error.code : `not an UltimateError: ${String(error)}`;
const statusOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined;

export const PROVIDER_TRANSPORT_CHECKS: readonly ProviderTransportCheck[] = [
  {
    name: "the caller's abort signal reaches fetch, generating and streaming",
    async run({ model, overHttp }) {
      const seen: unknown[] = [];
      const provider = overHttp(async (_url, init) => {
        seen.push(init.signal);
        return new Response('{"error":{"message":"stop here"}}', { status: 503 });
      }, KEY);
      const signal = new AbortController().signal;
      await Promise.all(bothPaths(provider, askOf(model, { signal })));
      expect(seen).toEqual([signal, signal]);
    },
  },
  {
    name: 'a request with no signal hands fetch none, rather than an explicit undefined',
    async run({ model, overHttp }) {
      const inits: RequestInit[] = [];
      const provider = overHttp(async (_url, init) => {
        inits.push(init);
        return new Response('{}', { status: 503 });
      }, KEY);
      await Promise.all(bothPaths(provider, askOf(model)));
      expect(inits.map((init) => 'signal' in init)).toEqual([false, false]);
    },
  },
  {
    name: 'a 4xx body echoing the key is a coded failure that never carries the key',
    async run({ model, overHttp }) {
      const provider = overHttp(answering(400, `rejected header x-api-key: ${KEY}`), KEY);
      for (const failure of await Promise.all(bothPaths(provider, askOf(model)))) {
        expect([codeOf(failure), statusOf(failure)]).toEqual(['X_AI_PROVIDER_UNAVAILABLE', 400]);
        expect(JSON.stringify(failure)).not.toContain(KEY);
        expect(isUltimateError(failure) ? failure.message : KEY).not.toContain(KEY);
      }
    },
  },
  {
    name: 'an endless 503 body ends in a coded failure, read only as far as the detail needs',
    async run({ model, overHttp }) {
      let pulled = 0;
      const provider = overHttp(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulled += 1;
                controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
              },
            }),
            { status: 503 },
          ),
        KEY,
      );
      const failure = await provider.generate(askOf(model)).catch((error: unknown) => error);
      expect([codeOf(failure), statusOf(failure)]).toEqual(['X_AI_PROVIDER_UNAVAILABLE', 503]);
      expect(pulled).toBeLessThan(10);
    },
  },
  {
    name: "a prompt over the window is X_AI_CONTEXT_OVERFLOW in either vendor's words, 400 or 413",
    async run({ model, overHttp }) {
      for (const message of OVERFLOWS) {
        for (const status of [400, 413]) {
          const provider = overHttp(answering(status, message), KEY);
          for (const failure of await Promise.all(bothPaths(provider, askOf(model)))) {
            expect(codeOf(failure)).toBe('X_AI_CONTEXT_OVERFLOW');
          }
        }
      }
    },
  },
  {
    name: 'a 400 about anything else, or the overflow words on a 5xx, stays the transport code',
    async run({ model, overHttp }) {
      for (const [status, message] of [
        [400, 'tools.0.input_schema: type must be object'],
        [503, OVERFLOWS[0] ?? ''],
      ] as const) {
        const provider = overHttp(answering(status, message), KEY);
        for (const failure of await Promise.all(bothPaths(provider, askOf(model)))) {
          expect([codeOf(failure), statusOf(failure)]).toEqual([
            'X_AI_PROVIDER_UNAVAILABLE',
            status,
          ]);
        }
      }
    },
  },
  {
    name: 'a request the wire cannot carry is refused before the socket',
    async run({ model, overHttp }) {
      let sent = 0;
      const provider = overHttp(async () => {
        sent += 1;
        return new Response('{}');
      }, KEY);
      const pdf = { type: 'base64', media_type: 'application/pdf', data: 'aGVsbG8=' } as const;
      const failure = await provider
        .generate({
          model,
          messages: [{ role: 'assistant', content: [{ type: 'document', source: pdf }] }],
          maxTokens: 16,
        })
        .catch((error: unknown) => error);
      expect([codeOf(failure), sent]).toEqual(['X_AI_CONTENT_UNSUPPORTED', 0]);
    },
  },
];

export const providerTransportConformance: SharedExamples<ProviderTransportSubject> =
  sharedExamples('an AI provider over HTTP', (subject) => {
    for (const check of PROVIDER_TRANSPORT_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  });
