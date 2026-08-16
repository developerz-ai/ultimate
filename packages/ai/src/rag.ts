// The retrieval pipeline: chunk → embed → retrieve → rerank → assemble under a token budget.
//
// The budget is the point. Retrieval that returns "the top 20 chunks" and lets the caller
// discover at request time that they don't fit is a truncation bug waiting to happen; the
// assembler fills to a declared ceiling and reports what it dropped.

import type { Embedder } from './embeddings';
import { embedBatched, embedOne } from './embeddings';
import { estimateTextTokens as estimateChunkTokens } from './provider';
import type { SearchHit, VectorStore } from './vector';

export interface Chunk {
  readonly id: string;
  readonly text: string;
  readonly tokens: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ChunkInput {
  readonly id: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Target chunk size in tokens. */
  readonly size?: number;
  /** Overlap in tokens. Without it a fact split across a boundary is retrievable by neither. */
  readonly overlap?: number;
}

/**
 * Token-aware chunker. Splits on paragraph, then sentence, then hard-wraps — so a chunk
 * boundary lands at a meaning boundary whenever one is available within the budget.
 */
export function chunk(input: ChunkInput): readonly Chunk[] {
  const size = input.size ?? 512;
  const overlap = Math.min(input.overlap ?? 64, size - 1);
  const units = splitUnits(input.text);
  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let tokens = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join(' ').trim();
    if (text !== '') {
      chunks.push({
        id: `${input.id}#${chunks.length}`,
        text,
        tokens: estimateChunkTokens(text),
        metadata: { source: input.id, ...(input.metadata ?? {}) },
      });
    }
    // Carry the tail forward as the overlap for the next chunk.
    const carried: string[] = [];
    let carriedTokens = 0;
    for (let i = buffer.length - 1; i >= 0 && carriedTokens < overlap; i -= 1) {
      const unit = buffer[i] ?? '';
      carried.unshift(unit);
      carriedTokens += estimateChunkTokens(unit);
    }
    buffer = carried;
    tokens = carriedTokens;
  };

  for (const unit of units) {
    const unitTokens = estimateChunkTokens(unit);
    if (tokens + unitTokens > size && buffer.length > 0) flush();
    buffer.push(unit);
    tokens += unitTokens;
  }
  flush();
  // The final flush leaves the overlap tail in the buffer; it is already covered.
  return chunks;
}

function splitUnits(text: string): readonly string[] {
  const units: string[] = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const trimmed = paragraph.trim();
    if (trimmed === '') continue;
    // Sentence split that keeps the terminator attached.
    const sentences = trimmed.match(/[^.!?]+[.!?]*\s*/g) ?? [trimmed];
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (s !== '') units.push(s);
    }
  }
  return units;
}

/** Index a document: chunk, embed, upsert. One call so no step is skipped by accident. */
export async function indexDocument(input: {
  readonly store: VectorStore;
  readonly embedder: Embedder;
  readonly document: ChunkInput;
}): Promise<readonly Chunk[]> {
  const chunks = chunk(input.document);
  const vectors = await embedBatched(
    input.embedder,
    chunks.map((c) => c.text),
  );
  await input.store.upsert(
    chunks.map((c, index) => ({
      id: c.id,
      vector: vectors[index] as Float32Array,
      text: c.text,
      metadata: c.metadata,
    })),
  );
  return chunks;
}

/** A reranker reorders candidates with a stronger (and slower) signal than retrieval. */
export interface Reranker {
  readonly name: string;
  rerank(input: {
    readonly query: string;
    readonly hits: readonly SearchHit[];
    readonly k: number;
  }): Promise<readonly SearchHit[]>;
}

/** Identity reranker — the honest default when no cross-encoder is configured. */
export const passthroughReranker: Reranker = {
  name: 'passthrough',
  rerank: async ({ hits, k }) => hits.slice(0, k),
};

export interface RetrieveInput {
  readonly store: VectorStore;
  readonly embedder: Embedder;
  readonly query: string;
  readonly k?: number;
  readonly filter?: Readonly<Record<string, string>>;
  readonly reranker?: Reranker;
}

/** Hybrid retrieval then rerank. Hybrid by default because pure vector loses on exact terms. */
export async function retrieve(input: RetrieveInput): Promise<readonly SearchHit[]> {
  const k = input.k ?? 8;
  const vector = await embedOne(input.embedder, input.query);
  const hits = await input.store.hybrid({
    query: input.query,
    vector,
    k: k * 3,
    ...(input.filter !== undefined ? { filter: input.filter } : {}),
  });
  const reranker = input.reranker ?? passthroughReranker;
  return reranker.rerank({ query: input.query, hits, k });
}

export interface AssembledContext {
  readonly text: string;
  readonly tokens: number;
  readonly used: readonly string[];
  /** Ids that did not fit. Reported, never silently dropped. */
  readonly dropped: readonly string[];
}

const BLOCK_OPEN = '<document id=';
const BLOCK_CLOSE = '</document>';

/**
 * One retrieved document, fenced and labelled with the id it came from. A bare separator was not
 * a boundary: it is a string a document can simply contain, and the assembled text lands in the
 * `user` message indistinguishable from the author's own instructions — while a tool RESULT
 * carries provenance and this carried none. So the fence is neutralised inside the payload, the
 * shape `cdata()` uses in `@ultimat3/seo`'s `xml.ts`: the marker is broken, never deleted, so the
 * model still reads every word the document actually said.
 *
 * Influence only, and deliberately not sold as more: the actor is `ctx.actor` and tool dispatch is
 * matched against `def.tools`, so retrieved text can persuade a model and can never authorise it.
 */
function documentBlock(id: string, text: string): string {
  const label = id.replaceAll('"', "'").replaceAll('>', ')').replaceAll('<', '(');
  const body = text
    .replaceAll(BLOCK_CLOSE, '<\\/document>')
    .replaceAll(BLOCK_OPEN, '<\\document id=');
  return `${BLOCK_OPEN}"${label}">\n${body}\n${BLOCK_CLOSE}`;
}

/**
 * Fill a context window in rank order until the budget is reached. Skips oversized hits
 * rather than stopping, so one long chunk does not starve every shorter one behind it.
 */
export function assembleContext(input: {
  readonly hits: readonly SearchHit[];
  readonly maxTokens: number;
  /** Between BLOCKS, never inside one — the block fence is what separates documents. */
  readonly separator?: string;
}): AssembledContext {
  const separator = input.separator ?? '\n\n';
  const separatorTokens = estimateChunkTokens(separator);
  const parts: string[] = [];
  const used: string[] = [];
  const dropped: string[] = [];
  let tokens = 0;

  for (const hit of input.hits) {
    const block = documentBlock(hit.id, hit.text);
    const cost = estimateChunkTokens(block) + (parts.length === 0 ? 0 : separatorTokens);
    if (tokens + cost > input.maxTokens) {
      dropped.push(hit.id);
      continue;
    }
    parts.push(block);
    used.push(hit.id);
    tokens += cost;
  }
  return { text: parts.join(separator), tokens, used, dropped };
}
