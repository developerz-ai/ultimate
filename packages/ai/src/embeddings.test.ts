/**
 * The two bounds in `embeddings.ts`, and they are the two shapes `scripts/finite-bounds.ts` says
 * it cannot see: a constructor option defaulted with `??`, and a bare default PARAMETER.
 *
 * Neither failure raised anything. `dimension: NaN` makes `new Float32Array(NaN)` a vector of
 * length ZERO, so every embedding is empty and `cosine` answers 0 for every pair — the silent
 * relevance collapse this file's own header says the declared dimension exists to catch.
 * `embedBatched(…, 0)` never advances `i`: measured under `timeout 10`, it issued the same empty
 * batch forever and was killed, having returned nothing.
 */

import { describe, expect, test } from 'bun:test';
import { asyncRefusal, NOT_A_BOUND, refusal } from './bounds-fixture';
import { cosine, embedBatched, HashEmbedder, normalize, tokenize } from './embeddings';

describe('HashEmbedder dimension', () => {
  test('a dimension that is not a whole count is refused where it is declared', () => {
    for (const dimension of [...NOT_A_BOUND, 2.5, 0, -1]) {
      const error = refusal(() => new HashEmbedder({ dimension }));
      expect(error.code).toBe('X_INVARIANT');
      expect(error.cause).toContain('dimension');
      expect(error.fix).toContain('HashEmbedder');
    }
  });

  test('the default and a declared width both still embed — the non-vacuity half', async () => {
    expect((await new HashEmbedder().embed(['alpha beta']))[0]?.length).toBe(256);
    expect((await new HashEmbedder({ dimension: 32 }).embed(['alpha beta']))[0]?.length).toBe(32);
  });
});

describe('embedBatched size', () => {
  test('a stride of zero is refused, because it is the loop that never advances', async () => {
    const error = await asyncRefusal(() => embedBatched(new HashEmbedder(), ['a', 'b'], 0));
    expect(error.cause).toContain('size');
    expect(error.fix).toContain('embedBatched');
  });

  test('a NaN stride is refused too — it sent ONE empty batch and answered zero vectors', async () => {
    for (const size of NOT_A_BOUND) {
      expect((await asyncRefusal(() => embedBatched(new HashEmbedder(), ['a'], size))).code).toBe(
        'X_INVARIANT',
      );
    }
  });

  test('an honest stride returns one vector per text, in order', async () => {
    const embedder = new HashEmbedder({ dimension: 16 });
    const texts = ['alpha', 'beta', 'gamma'];
    const batched = await embedBatched(embedder, texts, 2);
    expect(batched).toHaveLength(3);
    // Order survives the batching, which is the only thing this helper promises beyond the split.
    expect([...(batched[2] as Float32Array)]).toEqual([
      ...((await embedder.embed(['gamma']))[0] as Float32Array),
    ]);
  });
});

describe('the maths the two bounds protect', () => {
  test('cosine of a normalised pair is a dot product, and tokenize keeps digits', () => {
    const a = normalize(Float32Array.from([1, 0]));
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(tokenize('X_DB_DRIFT v2!')).toEqual(['x', 'db', 'drift', 'v2']);
  });
});
