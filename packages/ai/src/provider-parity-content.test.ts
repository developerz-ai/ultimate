/**
 * `provider-parity.test.ts`'s rule — one question, one answer, whichever wire format is asked —
 * for the image and document blocks. Apart from it only because that suite is at its line
 * ceiling. Each case asserts BOTH formats inside one `test()`, and a difference between them is
 * asserted as a difference, never left for one side to discover alone.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { secret } from '@ultimat3/core';
import type { AiMediaBlock } from './content-blocks';
import type { AiFetch } from './fetch-seam';
import {
  FIXTURE_ANTHROPIC_IDS,
  FIXTURE_OPENAI_IDS,
  registerFixtureModels,
  useFixtureModels,
} from './model-fixture';
import { chatCompletionBody } from './openai-body';
import { openAiProvider } from './openai-provider';
import { type AiMessage, AnthropicProvider } from './provider';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

const KEY = 'sk-live-do-not-log-me';
const OPENAI_MODEL = 'gpt-5.6-sol';
const ANTHROPIC_MODEL = 'claude-opus-5-5';

/** What the call threw, or `undefined` — so a case asserts the value rather than a `try` shape. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(() => {
  // `resetModels()` in another suite clears the whole registry, this format's specs included.
  registerFixtureModels();
});

describe('an image or a document reads the same on both wires, or is refused the same way', () => {
  const PNG = 'aGVsbG8=';
  const image: AiMediaBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  };
  const linked: AiMediaBlock = {
    type: 'image',
    source: { type: 'url', url: 'https://x.test/a.gif' },
  };
  const pdf: AiMediaBlock = {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: PNG },
    title: 'q3.pdf',
  };
  const ask = (...blocks: readonly AiMediaBlock[]): readonly AiMessage[] => [
    { role: 'user', content: [...blocks, { type: 'text', text: 'compare them' }] },
  ];
  const anthropicBody = (messages: readonly AiMessage[]) =>
    new AnthropicProvider({ models: FIXTURE_ANTHROPIC_IDS }).body({
      model: ANTHROPIC_MODEL,
      messages,
      maxTokens: 64,
    });
  const openaiBody = (messages: readonly AiMessage[]) =>
    chatCompletionBody({
      request: { messages, maxTokens: 64 },
      model: OPENAI_MODEL,
      stream: false,
      provider: 'openai',
    });

  test('the same blocks project onto each format, in block order', () => {
    const messages = ask(image, linked, pdf);
    // The Messages API's own shapes: the block IS the wire, passed through untouched.
    expect(anthropicBody(messages)['messages']).toEqual([
      { role: 'user', content: messages[0]?.content },
    ]);
    // Chat completions: a data URL or the URL itself for an image, a base64 file part for a PDF.
    expect(openaiBody(messages)['messages']).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
          { type: 'image_url', image_url: { url: 'https://x.test/a.gif' } },
          {
            type: 'file',
            file: { filename: 'q3.pdf', file_data: `data:application/pdf;base64,${PNG}` },
          },
          { type: 'text', text: 'compare them' },
        ],
      },
    ]);
  });

  test('a malformed block or an assistant-turn image is refused with one code on both', () => {
    const svg = { ...image, source: { ...image.source, media_type: 'image/svg+xml' } };
    const cases: readonly [readonly AiMessage[], string][] = [
      [ask(svg as AiMediaBlock), 'X_AI_REQUEST_INVALID'],
      [[{ role: 'assistant', content: [image] }], 'X_AI_CONTENT_UNSUPPORTED'],
    ];
    for (const [messages, code] of cases) {
      const errors = [
        thrownBy(() => anthropicBody(messages)),
        thrownBy(() => openaiBody(messages)),
      ] as { code?: string; cause?: string }[];
      for (const error of errors) {
        expect(error.code).toBe(code);
        expect(error.cause).toContain('messages[0].content[0]');
      }
    }
  });

  // The asserted DIFFERENCE: chat completions has no document-by-URL part and takes only PDFs, so
  // what the Messages API carries natively is refused there, naming the provider, never dropped.
  test('a document by URL, or as text, is carried by Anthropic and refused by the OpenAI format', () => {
    const byUrl: AiMediaBlock = {
      type: 'document',
      source: { type: 'url', url: 'https://x.test/a.pdf' },
    };
    const asText: AiMediaBlock = {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'the minutes' },
    };
    // Each fix names the block this format DOES take instead.
    for (const [block, instead] of [
      [byUrl, "type: 'base64'"],
      [asText, "type: 'text'"],
    ] as const) {
      expect(() => anthropicBody(ask(block))).not.toThrow();
      const error = thrownBy(() => openaiBody(ask(block))) as {
        code?: string;
        cause?: string;
        fix?: string;
      };
      expect(error.code).toBe('X_AI_CONTENT_UNSUPPORTED');
      expect(error.fix).toContain(instead);
      expect(error.cause).toContain('provider "openai"');
      expect(error.cause).toContain(OPENAI_MODEL);
    }
  });

  test('a refusal happens before the socket, on both providers', async () => {
    let sent = 0;
    const counting: AiFetch = async () => {
      sent += 1;
      return new Response('{}');
    };
    const bad = [{ role: 'assistant', content: [pdf] }] as const satisfies readonly AiMessage[];
    const anthropic = new AnthropicProvider({
      models: FIXTURE_ANTHROPIC_IDS,
      apiKey: KEY,
      fetch: counting,
    });
    const openai = openAiProvider({
      apiKey: secret(KEY, 'OPENAI_API_KEY'),
      models: [...FIXTURE_OPENAI_IDS],
      fetch: counting,
    });
    for (const call of [
      () => anthropic.generate({ model: ANTHROPIC_MODEL, messages: bad, maxTokens: 16 }),
      () => openai.generate({ model: OPENAI_MODEL, messages: bad, maxTokens: 16 }),
    ]) {
      const failure = await call().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as { code?: string }).code).toBe('X_AI_CONTENT_UNSUPPORTED');
    }
    expect(sent).toBe(0);
  });
});
