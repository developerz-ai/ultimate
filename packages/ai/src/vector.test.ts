import { describe, expect, test } from 'bun:test';
import { HashEmbedder, normalize } from './embeddings.ts';
import { assembleContext, chunk } from './rag.ts';
import { MemoryVectorStore } from './vector.ts';

const vec = (...values: number[]): Float32Array => normalize(Float32Array.from(values));

/**
 * Three documents where the embedding and the words disagree, which is the case hybrid
 * search exists for: the doc that literally contains the error code is NOT the one the
 * vector likes best.
 */
async function seeded(): Promise<MemoryVectorStore> {
  const store = new MemoryVectorStore({ dimension: 4, name: 'docs' });
  await store.upsert([
    {
      id: 'drift',
      text: 'X_DB_DRIFT means the schema differs from the migrations on disk',
      vector: vec(0.2, 1, 0, 0),
      metadata: { kind: 'error' },
    },
    {
      id: 'general',
      text: 'An overview of database design, table layout and general modelling guidance',
      vector: vec(1, 0, 0, 0),
      metadata: { kind: 'guide' },
    },
    {
      id: 'billing',
      text: 'How invoices are issued and how refunds are processed',
      vector: vec(0, 0, 1, 0),
      metadata: { kind: 'guide' },
    },
  ]);
  return store;
}

describe('hybrid search', () => {
  test('a term match outranks a stronger-but-vaguer vector match', async () => {
    const store = await seeded();
    const query = 'X_DB_DRIFT';
    const queryVector = vec(1, 0, 0, 0); // deliberately identical to "general"

    // Vector alone gets it wrong: the query embedding is a perfect match for the vague doc.
    const dense = await store.search(queryVector, 3);
    expect(dense[0]?.id).toBe('general');

    // Lexical alone finds the right one, because the error code is a rare exact term.
    const lexical = await store.searchText(query, 3);
    expect(lexical.map((h) => h.id)).toEqual(['drift']);

    // Fusion takes the lexical rank-1 seriously and lands on the right document.
    const hybrid = await store.hybrid({ query, vector: queryVector, k: 3 });
    expect(hybrid[0]?.id).toBe('drift');
    expect(hybrid[1]?.id).toBe('general');
  });

  test('a metadata filter applies to both halves of the fusion', async () => {
    const store = await seeded();
    const hits = await store.hybrid({
      query: 'X_DB_DRIFT',
      vector: vec(1, 0, 0, 0),
      k: 5,
      filter: { kind: 'guide' },
    });
    expect(hits.map((h) => h.id).sort()).toEqual(['billing', 'general']);
  });

  test('a vector of the wrong dimension is refused, not silently padded', async () => {
    const store = await seeded();
    await expect(store.upsert([{ id: 'x', text: 'x', vector: vec(1, 0) }])).rejects.toMatchObject({
      code: 'X_VECTOR_DIM_MISMATCH',
    });
  });
});

describe('embedding', () => {
  test('the hash embedder is deterministic and normalised', async () => {
    const embedder = new HashEmbedder({ dimension: 32 });
    const [a] = await embedder.embed(['the quick brown fox']);
    const [b] = await embedder.embed(['the quick brown fox']);
    expect(Array.from(a as Float32Array)).toEqual(Array.from(b as Float32Array));
    const magnitude = Math.sqrt(Array.from(a as Float32Array).reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 5);
  });
});

describe('chunking and assembly', () => {
  test('chunks stay under the size budget and carry source metadata', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about things.`).join(
      ' ',
    );
    const chunks = chunk({ id: 'doc-1', text, size: 40, overlap: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.tokens).toBeLessThanOrEqual(60);
      expect(c.metadata['source']).toBe('doc-1');
    }
  });

  test('assembly fills to the budget and reports what it dropped', () => {
    const hits = [
      { id: 'a', score: 3, text: 'a'.repeat(200), metadata: {} },
      { id: 'b', score: 2, text: 'b'.repeat(2_000), metadata: {} },
      { id: 'c', score: 1, text: 'c'.repeat(100), metadata: {} },
    ];
    const context = assembleContext({ hits, maxTokens: 100 });
    // 'b' is skipped rather than ending the fill, so 'c' still makes it in.
    expect(context.used).toEqual(['a', 'c']);
    expect(context.dropped).toEqual(['b']);
    expect(context.tokens).toBeLessThanOrEqual(100);
  });
});
