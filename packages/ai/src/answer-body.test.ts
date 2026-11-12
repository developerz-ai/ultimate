// A non-streamed answer whose 2xx body is not a JSON object — a proxy's HTML page, `null`, `[]`,
// a body past the cap — is a coded `X_AI_PROVIDER_UNAVAILABLE`, never a bare SyntaxError or
// TypeError and never an empty answer that reads as a success (`answer-body.ts`).

import { describe, expect, test } from 'bun:test';
import { ANSWER_BODY_MAX_BYTES } from './answer-body';
import { FIXTURE_MODEL, FIXTURE_OPENAI_IDS, useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import type { Provider } from './provider';
import { anthropicProvider, parseMessage } from './provider';
import { fakeFetch } from './provider-fixture';

useFixtureModels();

const BODIES: readonly (readonly [string, () => Response])[] = [
  ['an HTML page', () => new Response('<html>bad gateway</html>', { status: 200 })],
  ['null', () => new Response('null', { status: 200 })],
  ['an array', () => new Response('[]', { status: 200 })],
  ['a string', () => new Response('"ok"', { status: 200 })],
];

/** A valid answer of each wire, its text padded past the cap: only the cap can refuse it. */
const pad = 'x'.repeat(ANSWER_BODY_MAX_BYTES);
const OVERSIZED = {
  anthropic: {
    content: [{ type: 'text', text: pad }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  openai: {
    choices: [{ index: 0, message: { role: 'assistant', content: pad }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
} as const;

const providers: readonly (readonly [
  'anthropic' | 'openai',
  (reply: () => Response) => Provider,
  string,
])[] = [
  [
    'anthropic',
    (reply) =>
      anthropicProvider({ models: [FIXTURE_MODEL], apiKey: 'k', fetch: fakeFetch([], reply) }),
    FIXTURE_MODEL,
  ],
  [
    'openai',
    (reply) =>
      openAiProvider({ models: [FIXTURE_OPENAI_IDS[0]], apiKey: 'k', fetch: fakeFetch([], reply) }),
    FIXTURE_OPENAI_IDS[0],
  ],
];

describe('a non-streamed 2xx body that is not an answer', () => {
  for (const [wire, build, model] of providers) {
    for (const [label, reply] of BODIES) {
      test(`${wire}: ${label} is X_AI_PROVIDER_UNAVAILABLE`, async () => {
        const failure = await build(reply)
          .generate({ model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 })
          .then(
            () => expect.unreachable('a body that is not an answer resolved'),
            (error: unknown) => error,
          );
        expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
      });
    }

    test(`${wire}: a valid answer past ${ANSWER_BODY_MAX_BYTES} bytes is refused, not buffered`, async () => {
      const body = JSON.stringify(OVERSIZED[wire]);
      const failure = await build(() => new Response(body))
        .generate({ model, messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 })
        .then(
          () => expect.unreachable('an answer past the cap resolved'),
          (error: unknown) => error,
        );
      expect(failure).toMatchObject({ code: 'X_AI_PROVIDER_UNAVAILABLE' });
    });
  }

  test('parseMessage refuses a raw value that is not an object', () => {
    for (const raw of [null, [], 'text', 7]) {
      expect(() => parseMessage(FIXTURE_MODEL, raw)).toThrow(
        expect.objectContaining({ code: 'X_AI_PROVIDER_UNAVAILABLE' }),
      );
    }
  });
});
