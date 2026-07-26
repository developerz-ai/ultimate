// The embedding interface plus a deterministic hash embedder for tests and `x dev`.
//
// The dimension lives in the TYPE, not in a config file: a store built with one embedder and
// queried with another is a silent relevance collapse, and the only place to catch it is
// where the two meet. `VectorStore` compares the declared dimension and refuses.

import { AiNotImplementedError } from './errors.ts';

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
  if (vector === undefined) throw new Error(`embedder ${embedder.name} returned no vector`);
  return vector;
}

/**
 * Split a batch into chunks of `size`, preserving order. Providers cap batch size, and a
 * caller that embeds a 50k-chunk corpus should not have to know each provider's cap.
 */
export async function embedBatched(
  embedder: Embedder,
  texts: readonly string[],
  size = 96,
): Promise<readonly Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += size) {
    out.push(...(await embedder.embed(texts.slice(i, i + size))));
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
    this.dimension = input.dimension ?? 256;
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => this.one(text));
  }

  private one(text: string): Float32Array {
    const vector = new Float32Array(this.dimension);
    for (const token of tokenize(text)) {
      const slot = fnv1a(token) % this.dimension;
      // Signed accumulation: without it every vector is non-negative and cosine
      // similarity compresses into a narrow band where nothing ranks apart.
      const sign = fnv1a(`${token}#sign`) % 2 === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }
    return normalize(vector);
  }
}

/** A real remote embedder needs a key and a transport; the interface is complete without it. */
export class RemoteEmbedder implements Embedder {
  readonly name: string;
  readonly dimension: number;

  constructor(input: { name: string; dimension: number }) {
    this.name = input.name;
    this.dimension = input.dimension;
  }

  async embed(_texts: readonly string[]): Promise<readonly Float32Array[]> {
    throw new AiNotImplementedError({
      feature: `RemoteEmbedder("${this.name}")`,
      fix: 'set EMBEDDINGS_API_KEY and configure ai.embeddings in app.config.ts, or use HashEmbedder in dev',
    });
  }
}

/** Lowercased word tokens. Punctuation is dropped; digits are kept (versions, ids). */
export function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** FNV-1a 32-bit. Chosen for stability across runtimes, not for cryptographic strength. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** L2 normalise in place so cosine similarity reduces to a dot product. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return vector;
  const inverse = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i += 1) vector[i] = (vector[i] ?? 0) * inverse;
  return vector;
}

/** Dot product. Correct as cosine only for normalised vectors — which `normalize` ensures. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}
