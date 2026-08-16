// The production embedder: one HTTP client for the `/v1/embeddings` request shape.
//
// Anthropic ships no embeddings endpoint, and its documented partner speaks the same
// `{ model, input[] }` -> `{ data: [{ index, embedding }] }` shape as every other hosted or
// self-hosted embedder worth pointing at. So there is ONE remote embedder rather than one per
// vendor: `baseUrl` selects the provider and nothing else changes. A second class per vendor
// would be a second thing to learn for a difference that does not exist on the wire.

import type { Embedder } from './embeddings';
import { normalize } from './embeddings';
import { AiKeyMissingError, AiTransportError, EmbedderDimMismatchError } from './errors';

const API_KEY_ENV = 'EMBEDDINGS_API_KEY';
const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1';
/** Providers cap a batch around 128 inputs; 96 leaves headroom for long texts. */
const DEFAULT_BATCH_SIZE = 96;
const DETAIL_LIMIT = 300;

export interface RemoteEmbedderInput {
  /** The provider's model id. Doubles as the embedder name, so a store records what wrote it. */
  readonly name: string;
  /**
   * Declared once, checked on EVERY response. A provider that quietly changes width would
   * otherwise poison a store one batch at a time, and cosine similarity does not complain.
   */
  readonly dimension: number;
  /** Reads `EMBEDDINGS_API_KEY` when omitted. Absent at call time is a labelled throw. */
  readonly apiKey?: string;
  /** Any endpoint speaking the same shape. Defaults to Voyage. */
  readonly baseUrl?: string;
  /** Inputs per request. Larger calls are split; the provider's own cap is not the caller's. */
  readonly batchSize?: number;
  /** Injectable so a test can assert the request body without a network. Defaults to `fetch`. */
  readonly fetch?: typeof fetch;
}

export class RemoteEmbedder implements Embedder {
  readonly name: string;
  readonly dimension: number;
  private readonly config: RemoteEmbedderInput;

  constructor(input: RemoteEmbedderInput) {
    this.name = input.name;
    this.dimension = input.dimension;
    this.config = input;
  }

  /**
   * Batches are issued in sequence, not in parallel: a 50k-chunk corpus fanned out at once
   * reproduces the rate limit it is trying to get through, and order must survive either way.
   */
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) return [];
    const size = this.config.batchSize ?? DEFAULT_BATCH_SIZE;
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += size) {
      vectors.push(...(await this.batch(texts.slice(start, start + size))));
    }
    return vectors;
  }

  private async batch(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const apiKey = this.config.apiKey ?? Bun.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new AiKeyMissingError({ provider: this.name, envVar: API_KEY_ENV });
    }
    const doFetch = this.config.fetch ?? fetch;
    const response = await doFetch(`${this.config.baseUrl ?? DEFAULT_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.name, input: texts }),
    });
    if (!response.ok) {
      throw new AiTransportError({
        provider: this.name,
        status: response.status,
        detail: (await response.text().catch(() => '')).slice(0, DETAIL_LIMIT),
        envVar: API_KEY_ENV,
      });
    }
    return this.decode((await response.json()) as unknown, texts.length);
  }

  private decode(payload: unknown, expected: number): readonly Float32Array[] {
    const data = asRecord(payload)?.['data'];
    if (!Array.isArray(data) || data.length !== expected) {
      throw this.malformed(`expected ${expected} embeddings, got ${countOf(data)}`);
    }
    // Keyed by the provider's own `index` rather than array position: the two agree today, and
    // a store written in the wrong order is a silent relevance collapse if they ever stop.
    const vectors = new Array<Float32Array | undefined>(expected);
    for (let position = 0; position < data.length; position += 1) {
      const entry = asRecord(data[position]);
      const index = entry?.['index'];
      const slot = typeof index === 'number' ? index : position;
      if (!Number.isInteger(slot) || slot < 0 || slot >= expected) {
        throw this.malformed(`embedding at position ${position} claims index ${String(index)}`);
      }
      vectors[slot] = this.vectorOf(entry?.['embedding'], position);
    }
    const missing = vectors.indexOf(undefined);
    if (missing !== -1) throw this.malformed(`no embedding for input ${missing}`);
    return vectors.filter((vector): vector is Float32Array => vector !== undefined);
  }

  /**
   * L2 normalised on the way in, like every other embedder here, so `cosine` stays a dot
   * product. Providers already return unit vectors, which makes this a no-op — but "already"
   * is a property of today's provider, not of the interface.
   */
  private vectorOf(raw: unknown, position: number): Float32Array {
    if (!Array.isArray(raw))
      throw this.malformed(`embedding at position ${position} is not an array`);
    if (raw.length !== this.dimension) {
      throw new EmbedderDimMismatchError({
        embedder: this.name,
        expected: this.dimension,
        received: raw.length,
      });
    }
    const vector = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      const value: unknown = raw[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw this.malformed(`embedding at position ${position} has a non-numeric component`);
      }
      vector[i] = value;
    }
    return normalize(vector);
  }

  private malformed(detail: string): AiTransportError {
    return new AiTransportError({ provider: this.name, detail });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function countOf(data: unknown): string {
  return Array.isArray(data) ? String(data.length) : 'no data array';
}
