/**
 * The image and document blocks: what the screen lets through untouched, what it refuses as
 * malformed (`X_AI_REQUEST_INVALID`) and what it refuses as untakeable (`X_AI_CONTENT_UNSUPPORTED`),
 * and what they add to the pre-flight estimate. Both wire formats run the same screen; the
 * per-format projections are `provider-parity.test.ts`'s.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type AiMediaBlock,
  assertMediaContent,
  IMAGE_TOKEN_ESTIMATE,
  MAX_DOCUMENT_BASE64_CHARS,
  MAX_IMAGE_BASE64_CHARS,
} from './content-blocks';
import { AiContentUnsupportedError } from './content-errors';
import { AiRequestInvalidError } from './errors';
import { createGateway } from './gateway';
import { modelSpec, registerModel, resetModels } from './models';
import { type AiMessage, AnthropicProvider, estimateInputTokens, messageText } from './provider';

const TARGET = { provider: 'anthropic', model: 'claude-opus-5-5' } as const;
const DATA = 'aGVsbG8=';

const image: AiMediaBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: DATA },
};
const pdf: AiMediaBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: DATA },
  title: 'Q3 report',
};

const turn = (block: unknown, role: 'user' | 'assistant' = 'user'): readonly AiMessage[] => [
  { role, content: [{ type: 'text', text: 'read this' }, block as AiMediaBlock] },
];

/** The thrown value, asserted to be one of the two coded refusals. */
function refusalOf(
  messages: readonly AiMessage[],
  target: { readonly provider: string; readonly model: string } = TARGET,
) {
  try {
    assertMediaContent(messages, target);
  } catch (error) {
    expect(
      error instanceof AiRequestInvalidError || error instanceof AiContentUnsupportedError,
    ).toBe(true);
    return error as AiRequestInvalidError | AiContentUnsupportedError;
  }
  return expect.unreachable('the screen let a refused block through');
}

afterEach(() => {
  resetModels();
});

describe('a well-formed block passes, and the Anthropic body carries it untouched', () => {
  const blocks: readonly AiMediaBlock[] = [
    image,
    { type: 'image', source: { type: 'url', url: 'https://cdn.example.com/a.webp' } },
    pdf,
    { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain' } },
  ];

  test('every source of both kinds', () => {
    for (const block of blocks) {
      const body = new AnthropicProvider().body({
        model: TARGET.model,
        messages: turn(block),
        maxTokens: 100,
      });
      expect(body['messages']).toEqual([{ role: 'user', content: turn(block)[0]?.content }]);
    }
  });

  test('a base64 string exactly at its ceiling passes; four characters more is refused', () => {
    const at = (cap: number) => 'A'.repeat(cap);
    const img = (data: string) => turn({ ...image, source: { ...image.source, data } });
    const doc = (data: string) => turn({ ...pdf, source: { ...pdf.source, data } });
    expect(() => assertMediaContent(img(at(MAX_IMAGE_BASE64_CHARS)), TARGET)).not.toThrow();
    expect(refusalOf(img(at(MAX_IMAGE_BASE64_CHARS + 4))).code).toBe('X_AI_REQUEST_INVALID');
    expect(() => assertMediaContent(doc(at(MAX_DOCUMENT_BASE64_CHARS)), TARGET)).not.toThrow();
    expect(refusalOf(doc(at(MAX_DOCUMENT_BASE64_CHARS + 4))).code).toBe('X_AI_REQUEST_INVALID');
  });
});

describe('a malformed block is X_AI_REQUEST_INVALID, naming where it is', () => {
  const malformed: Readonly<Record<string, unknown>> = {
    'an svg image': { type: 'image', source: { ...image.source, media_type: 'image/svg+xml' } },
    'a pdf media type on an image': {
      type: 'image',
      source: { ...image.source, media_type: 'application/pdf' },
    },
    'a docx document': { ...pdf, source: { ...pdf.source, media_type: 'application/msword' } },
    'a data: prefix': {
      ...image,
      source: { ...image.source, data: `data:image/png;base64,${DATA}` },
    },
    'whitespace in the base64': { ...image, source: { ...image.source, data: 'aGVs\nbG8=' } },
    'unpadded base64': { ...image, source: { ...image.source, data: 'aGVsbG8' } },
    'url-safe base64': { ...image, source: { ...image.source, data: 'aGV_bG8-' } },
    'empty base64': { ...image, source: { ...image.source, data: '' } },
    'base64 that is not a string': { ...image, source: { ...image.source, data: 42 } },
    'an http url': { type: 'image', source: { type: 'url', url: 'http://example.com/a.png' } },
    'a data: url': { type: 'image', source: { type: 'url', url: `data:image/png;base64,${DATA}` } },
    'an unparseable url': { type: 'document', source: { type: 'url', url: 'not a url' } },
    'a text source on an image': {
      type: 'image',
      source: { type: 'text', media_type: 'text/plain', data: 'x' },
    },
    'an unknown source type': { type: 'image', source: { type: 'file', file_id: 'f_1' } },
    'no source at all': { type: 'document' },
    'an empty text document': {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: '' },
    },
    'a markdown text document': {
      type: 'document',
      source: { type: 'text', media_type: 'text/markdown', data: '# hi' },
    },
    'a non-string title': { ...pdf, title: 7 },
  };

  for (const [name, block] of Object.entries(malformed)) {
    test(name, () => {
      const error = refusalOf(turn(block));
      expect(error.code).toBe('X_AI_REQUEST_INVALID');
      expect(error.cause).toContain('messages[0].content[1]');
      expect(error.fix.length).toBeGreaterThan(0);
    });
  }
});

describe('a block the target cannot take is X_AI_CONTENT_UNSUPPORTED', () => {
  test('in an assistant turn, on either kind', () => {
    for (const block of [image, pdf]) {
      const error = refusalOf(turn(block, 'assistant'));
      expect(error.code).toBe('X_AI_CONTENT_UNSUPPORTED');
      expect(error.cause).toContain('assistant');
      expect(error.fix).toContain("role: 'user'");
    }
  });

  // An app's own row with no `input` is TEXT ONLY: an image sent there is a 400, or worse, an
  // answer about a picture the model never saw.
  test('to a model whose row does not list the kind, naming the model and the fix', () => {
    registerModel({ ...modelSpec('claude-opus-5'), id: 'acme-text-70b', input: ['document'] });
    const target = { provider: 'acme', model: 'acme-text-70b' };
    const error = refusalOf(turn(image), target);
    expect(error.code).toBe('X_AI_CONTENT_UNSUPPORTED');
    expect(error.cause).toContain('acme-text-70b');
    expect(error.cause).toContain("'image'");
    expect(error.fix).toContain('registerModel(');
    expect(() => assertMediaContent(turn(pdf), target)).not.toThrow();
  });

  test('a row with no input list at all takes neither kind', () => {
    const { input: _dropped, ...spec } = modelSpec('claude-opus-5');
    registerModel({ ...spec, id: 'acme-plain' });
    const target = { provider: 'acme', model: 'acme-plain' };
    expect(refusalOf(turn(image), target).code).toBe('X_AI_CONTENT_UNSUPPORTED');
    expect(refusalOf(turn(pdf), target).code).toBe('X_AI_CONTENT_UNSUPPORTED');
  });
});

describe('the pre-flight estimate counts what a media block costs', () => {
  const base = (messages: readonly AiMessage[]) =>
    estimateInputTokens({ model: TARGET.model, messages, maxTokens: 1 });

  test('an image is its worst case; a PDF is its base64 over four; neither is read as prose', () => {
    const prose = base([{ role: 'user', content: [{ type: 'text', text: 'read this' }] }]);
    expect(base(turn(image)) - prose).toBe(IMAGE_TOKEN_ESTIMATE);
    expect(base(turn(pdf)) - prose).toBe(Math.ceil(DATA.length / 4));
    expect(messageText(turn(image)[0] as AiMessage)).not.toContain(DATA);
  });

  test("a text document's words are counted once, as text", () => {
    const text = turn({
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'x'.repeat(400) },
    });
    expect(messageText(text[0] as AiMessage)).toContain('x'.repeat(400));
    expect(base(text)).toBe(base([{ role: 'user', content: `read this ${'x'.repeat(400)}` }]));
  });

  // The gateway estimates BEFORE the provider screens, so a malformed block must not be a bare
  // TypeError here — it is estimated as nothing and refused, coded, a moment later.
  test('a malformed block is estimated without throwing', () => {
    expect(() =>
      base(turn({ type: 'document', source: { type: 'base64', data: 9 } })),
    ).not.toThrow();
  });
});

describe('a replayed block with no source never crashes the pre-flight', () => {
  // The gateway estimates BEFORE the provider screens. A `{ type: 'document' }` with no source, or
  // a null one, read `source.type` there and surfaced as a bare TypeError, not the coded refusal.
  test('a sourceless or null-source document through gateway.generate is X_AI_REQUEST_INVALID', async () => {
    const gateway = createGateway({
      providers: [new AnthropicProvider({ apiKey: 'k', fetch: async () => new Response('{}') })],
    });
    for (const block of [
      { type: 'document' },
      { type: 'document', source: null },
      { type: 'image', source: null },
    ]) {
      const failure = await gateway
        .generate({ model: TARGET.model, messages: turn(block), maxTokens: 16 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).not.toBeInstanceOf(TypeError);
      expect((failure as { code?: string }).code).toBe('X_AI_REQUEST_INVALID');
    }
    expect(() =>
      messageText(turn({ type: 'document', source: null })[0] as AiMessage),
    ).not.toThrow();
  });
});
