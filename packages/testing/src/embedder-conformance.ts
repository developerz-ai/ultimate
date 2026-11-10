// The `embedder` port's contract as shared examples: `behavesLike(embedderConformance, () => yours)`.
// What `@ultimat3/ai`'s semantic cache and vector store assume of an `Embedder` and never re-check
// per call: one vector per text, in order, of the declared dimension, finite, with a direction.

import { expect, test } from 'bun:test';
import type { Embedder } from '@ultimat3/ai/adapter';
import type { SharedExamples } from './shared-examples';
import { sharedExamples } from './shared-examples';

export interface EmbedderCheck {
  readonly name: string;
  run(embedder: Embedder): Promise<void>;
}

/** Near-equal, not equal: a remote model may differ in the last bits between two calls. */
const SAME_DIRECTION = 0.999;

const TEXTS = ['list my orders', 'the invoice for March', 'reset my password'] as const;

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const EMBEDDER_CHECKS: readonly EmbedderCheck[] = [
  {
    name: 'it names itself and declares a whole, positive dimension',
    async run(embedder) {
      expect(embedder.name.length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(embedder.dimension) && embedder.dimension > 0).toBe(true);
    },
  },
  {
    name: 'one vector per text, of the declared dimension, every component finite',
    async run(embedder) {
      const vectors = await embedder.embed(TEXTS);
      expect(vectors.length).toBe(TEXTS.length);
      for (const vector of vectors) {
        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(embedder.dimension);
        expect(vector.every((component) => Number.isFinite(component))).toBe(true);
      }
    },
  },
  {
    name: 'an empty batch answers no vectors, never one',
    async run(embedder) {
      expect((await embedder.embed([])).length).toBe(0);
    },
  },
  {
    name: 'a text has a direction: no all-zero vector, which every cosine answers NaN against',
    async run(embedder) {
      for (const vector of await embedder.embed(TEXTS)) {
        expect(vector.some((component) => component !== 0)).toBe(true);
      }
    },
  },
  {
    name: 'the batch keeps the order the texts arrived in',
    async run(embedder) {
      // Against each text alone: a one-text batch has no order to get wrong.
      const batch = await embedder.embed(TEXTS);
      for (let at = 0; at < TEXTS.length; at += 1) {
        const [alone] = await embedder.embed([TEXTS[at] ?? '']);
        const inBatch = batch[at];
        if (alone === undefined || inBatch === undefined) return expect.unreachable();
        expect(cosine(inBatch, alone)).toBeGreaterThan(SAME_DIRECTION);
      }
    },
  },
  {
    name: 'the same text twice is the same direction: a cache keyed on it can hit',
    async run(embedder) {
      const [first] = await embedder.embed([TEXTS[0]]);
      const [again] = await embedder.embed([TEXTS[0]]);
      if (first === undefined || again === undefined) return expect.unreachable();
      expect(cosine(first, again)).toBeGreaterThan(SAME_DIRECTION);
    },
  },
];

export const embedderConformance: SharedExamples<Embedder> = sharedExamples(
  'an embedder',
  (subject) => {
    for (const check of EMBEDDER_CHECKS) {
      test(check.name, async () => {
        await check.run(subject());
      });
    }
  },
);
