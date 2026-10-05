// The embedding interface, the vector maths every store shares, and a deterministic hash
// embedder for tests and `x dev`. The remote one lives in ./remote-embedder.
//
// The dimension lives in the TYPE, not in a config file: a store built with one embedder and
// queried with another is a silent relevance collapse, and the only place to catch it is
// where the two meet. `VectorStore` compares the declared dimension and refuses.

import { fingerprint, finiteCount } from '@ultimat3/core';
import { AiEmbedderInvalidError } from './errors';

export interface Embedder {
  readonly name: string;
  /** Declared once, checked everywhere. */
  readonly dimension: number;
  /** Batched: an embedder that only does one text at a time is a per-chunk round trip. */
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

/** Embed one text without building an array at the call site. */
export async function embedOne(embedder: Embedder, text: string): Promise<Float32Array> {
  const [vector] = await embedder.embed([text]);
  if (vector === undefined) throw new AiEmbedderInvalidError({ embedder: embedder.name });
  return vector;
}

/**
 * Split a batch into chunks of `size`, preserving order. Providers cap batch size, and a
 * caller that embeds a 50k-chunk corpus should not have to know each provider's cap.
 */
export async function embedBatched(
  embedder: Embedder,
  texts: readonly string[],
  size: number = 96,
): Promise<readonly Float32Array[]> {
  // A default PARAMETER is a bound like any option, and this one is the loop's stride: `size: 0`
  // never advances `i` and issues the same empty batch to a paid endpoint forever — measured, a
  // synchronous-looking `await` loop that never returns — while `size: NaN` sends ONE request of
  // zero inputs and answers with zero vectors for however many texts it was given. Hence a floor
  // of 1: there is no batch of nothing.
  finiteCount('embedBatched', 'size', size, 1);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    const vectors = await embedder.embed(batch);
    // "One vector per input text, in the order the texts arrived" is this interface's invariant,
    // and it is the last place it can be checked: `indexDocument` writes `vectors[index]` per
    // chunk, so a short answer stored `undefined` as a row and surfaced a layer later as a
    // `TypeError` inside the vector store, naming nothing the app author wrote.
    // `RemoteEmbedder.decode` already refuses its own provider on the same rule — an app's own
    // `Embedder` was the unchecked half.
    if (vectors.length !== batch.length) {
      throw new AiEmbedderInvalidError({
        embedder: embedder.name,
        expected: batch.length,
        received: vectors.length,
      });
    }
    out.push(...vectors);
  }
  return out;
}

export interface HashEmbedderInput {
  readonly dimension?: number;
}

/**
 * Deterministic bag-of-words hashing embedder. Not semantic — two paraphrases share no
 * vocabulary and land far apart — but it IS stable, dependency-free, and fast, which is
 * what a test fixture and a `x dev` boot without an API key actually need. Shared words
 * produce genuine similarity, so relevance tests are meaningful rather than tautological.
 */
export class HashEmbedder implements Embedder {
  readonly name = 'hash';
  readonly dimension: number;

  constructor(input: HashEmbedderInput = {}) {
    // Floored at 1: `new Float32Array(NaN)` is a vector of LENGTH ZERO, so every embedding is
    // empty, `cosine` answers `NaN` for every pair, and the ranking collapses with nothing thrown —
    // the silent relevance collapse this file's own header says the dimension exists to catch.
    this.dimension = finiteCount('HashEmbedder', 'dimension', input.dimension ?? 256, 1);
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    for (const token of tokenize(text)) {
      const slot = hashOf(token) % this.dimension;
      // Signed accumulation: without it every vector is non-negative and cosine
      // similarity compresses into a narrow band where nothing ranks apart.
      const sign = hashOf(`${token}#sign`) % 2 === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }
    return normalize(vector);
  }
}

/** Lowercased word tokens. Punctuation is dropped; digits are kept (versions, ids). */
export function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * A token's slot hash: 32 bits of core's `fingerprint`, never a local FNV-1a. FNV-1a/32 collides on
 * ordinary words (`costarring` / `liquid`), and two colliding words embed IDENTICALLY here — cosine
 * 1, so a semantic lookup answered one with the other's entry.
 */
function hashOf(text: string): number {
  return Number.parseInt(fingerprint(text).slice(0, 8), 16);
}

/** L2 normalise in place, so every embedder hands a store unit vectors whatever its scale. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;
  const inverse = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) * inverse;
  return vector;
}

/**
 * Cosine similarity — pgvector's `1 - (a <=> b)`, computed the way pgvector computes it, so the dev
 * store and production rank alike. A bare dot product was cosine only for unit vectors, and a
 * store accepts whatever an app upserts. A zero-norm side is `0 / 0`: `NaN`, as pgvector answers,
 * never a `0` that would rank a vector with no direction above every opposed one. Clamped to
 * [-1, 1] as pgvector clamps, so float error never reports a similarity past identical.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const similarity = dot / Math.sqrt(normA * normB);
  return similarity > 1 ? 1 : similarity < -1 ? -1 : similarity;
}
