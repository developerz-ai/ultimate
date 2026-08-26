/**
 * The chunker's contract is its own header's: paragraph, then sentence, then a HARD WRAP. The
 * wrap is what makes the rest of the loop terminate — a unit bigger than the whole budget can
 * never be flushed by a size check, so it stayed in the buffer and rode every chunk after it.
 */

import { describe, expect, test } from 'bun:test';
import { asyncRefusal, NOT_A_BOUND, refusal } from './bounds-fixture';
import { HashEmbedder } from './embeddings';
import { estimateTextTokens } from './provider';
import { assembleContext, chunk, retrieve } from './rag';
import { MemoryVectorStore } from './vector';

const SIZE = 128;
const OVERLAP = 32;

/** One paragraph of `count` short words and no sentence terminator — one unit, however long. */
function unbrokenParagraph(count: number): string {
  return Array.from({ length: count }, (_, i) => `token${i}`).join(' ');
}

describe('chunk() wraps what the sentence split could not break', () => {
  test('a paragraph with no terminator is wrapped to the budget instead of passed through', () => {
    const text = unbrokenParagraph(400);
    const chunks = chunk({ id: 'doc', text, size: SIZE, overlap: OVERLAP });

    expect(chunks.length).toBeGreaterThan(1);
    for (const piece of chunks) {
      // The join adds a space per unit, so the budget is a budget and not an identity — but a
      // chunk twice the declared size is the truncation bug the ceiling exists to prevent.
      expect(piece.tokens).toBeLessThanOrEqual(SIZE * 1.5);
    }
  });

  test('an oversized unit does not re-seed every chunk after it', () => {
    // The measured failure: a ~1,000-token document became nine chunks totalling ~9,000 tokens,
    // every one of them carrying the same oversized sentence.
    const text = `${unbrokenParagraph(300)}\n\nShort one. Short two. Short three. Short four.`;
    const documentTokens = estimateTextTokens(text);
    const chunks = chunk({ id: 'doc', text, size: SIZE, overlap: OVERLAP });
    const total = chunks.reduce((sum, piece) => sum + piece.tokens, 0);

    // Overlap duplicates a tail per boundary and nothing else, so the whole index is bounded by
    // the document plus that tail — never a multiple of it.
    expect(total).toBeLessThanOrEqual(documentTokens + OVERLAP * chunks.length + SIZE);
    // One distinctive word belongs to one chunk, plus at most the one that carries it as overlap.
    const carrying = chunks.filter((piece) => piece.text.includes('token0'));
    expect(carrying.length).toBeLessThanOrEqual(2);
  });

  test('an unbroken run with no space in it is still cut', () => {
    // Base64, a minified line, a CJK paragraph this splitter's `[.!?]` alphabet cannot see: there
    // is no word boundary to prefer, and no boundary at all is not an option.
    const chunks = chunk({ id: 'blob', text: 'x'.repeat(4_000), size: SIZE, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const piece of chunks) expect(piece.tokens).toBeLessThanOrEqual(SIZE);
    expect(chunks.map((piece) => piece.text).join('')).toBe('x'.repeat(4_000));
  });

  test('the wrap loses no words', () => {
    const text = unbrokenParagraph(200);
    const chunks = chunk({ id: 'doc', text, size: SIZE, overlap: 0 });
    // `overlap: 0` so the join is the document back, not the document plus its carried tails.
    expect(chunks.map((piece) => piece.text).join(' ')).toBe(text);
  });

  test('a document that already fits is one chunk, untouched', () => {
    const chunks = chunk({ id: 'small', text: 'One sentence. Two sentences.', size: SIZE });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('One sentence. Two sentences.');
  });

  test('the overlap still carries a tail forward — the cap must not delete it', () => {
    // Sentences well under the budget, so the carry loop is the only thing joining two chunks.
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`);
    const chunks = chunk({ id: 'doc', text: sentences.join(' '), size: SIZE, overlap: OVERLAP });

    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0]?.text ?? '';
    const second = chunks[1]?.text ?? '';
    // The second chunk OPENS with material the first one already carried — that is what stops a
    // fact split across the boundary from being retrievable by neither.
    const opening = second.slice(0, second.indexOf('.') + 1);
    expect(opening).not.toBe('');
    expect(first).toContain(opening);
    // ...and it is a tail, not the whole of the first chunk: a carry that keeps everything is the
    // loop that never terminates.
    expect(second).not.toContain(first);
  });

  test('metadata and ids are stable and ordered', () => {
    const chunks = chunk({
      id: 'doc',
      text: unbrokenParagraph(200),
      size: SIZE,
      metadata: { lang: 'en' },
    });
    expect(chunks.map((piece) => piece.id)).toEqual(chunks.map((_, i) => `doc#${i}`));
    expect(chunks[0]?.metadata).toEqual({ source: 'doc', lang: 'en' });
  });
});

/**
 * The pipeline's four bounds. `chunk`'s `size` is the one that made this a sweep rather than a
 * tidy-up: `Math.max(1, Math.floor(NaN))` is `NaN`, every `<= size` in the wrap reads false, and
 * `cutToBudget` slices at `NaN` forever — a SYNCHRONOUS loop, on the only thread, past every
 * `AbortSignal` and past the job timeout. Measured before the screen existed: 10s under `timeout`,
 * killed, never returned. The other three fail as successes instead.
 */
describe('a chunk, a retrieval and an assembly all refuse a bound that is not one', () => {
  test('chunk() refuses a size no clamp can repair, and it is the clamp that hid it', () => {
    for (const size of NOT_A_BOUND) {
      const error = refusal(() => chunk({ id: 'doc', text: 'alpha beta gamma', size }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('size');
      expect(error.fix).toContain('chunk');
    }
    // The deliberate flooring is untouched: a fractional budget is still floored, `size: 0` is
    // still read as one token, and both are what `rag.ts`'s own comment promises.
    expect(chunk({ id: 'doc', text: 'alpha beta gamma', size: 0 }).length).toBeGreaterThan(0);
    expect(chunk({ id: 'doc', text: 'alpha beta gamma', size: 12.5 }).length).toBeGreaterThan(0);
  });

  test('an overlap that is not a number is refused rather than silently dropping the carry', () => {
    expect(refusal(() => chunk({ id: 'doc', text: 'a b c', overlap: Number.NaN })).cause).toContain(
      'overlap',
    );
    // Zero stays legal — two tests above rely on it to join chunks back into the document.
    expect(chunk({ id: 'doc', text: 'a b c', size: 8, overlap: 0 }).length).toBeGreaterThan(0);
  });

  test('assembleContext refuses the ceiling that has no default at all', () => {
    const hits = [{ id: 'a', score: 1, text: 'x '.repeat(2_000), metadata: {} }];
    const error = refusal(() => assembleContext({ hits, maxTokens: Number.NaN }));
    expect(error.cause).toContain('maxTokens');
    // What it was doing instead: `tokens + cost > NaN` is false, so every document was accepted
    // and `dropped` stayed empty — a context budget that reported a clean fill of any size.
    expect(assembleContext({ hits, maxTokens: 10 }).dropped).toEqual(['a']);
  });

  test('retrieve() names its own k, not the k * 3 the store is asked for', async () => {
    const store = new MemoryVectorStore({ dimension: 256 });
    const embedder = new HashEmbedder();
    const error = await asyncRefusal(() =>
      retrieve({ store, embedder, query: 'drift', k: Number.NaN }),
    );
    expect(error.cause).toContain('retrieve');
    expect(error.cause).toContain('k');
  });
});
