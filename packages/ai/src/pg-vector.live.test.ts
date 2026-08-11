// `PgVectorStore` against a real pgvector. `pg-vector.test.ts` asserts the statement text every
// method compiles to; nothing there proves Postgres accepts it, that the table `ddl()` writes is
// the table the queries read, or that a tenant filter compiled into SQL actually excludes a row.
// The one bug this store has already shipped was exactly that shape — metadata bound `::jsonb`
// was JSON-encoded twice, read back correctly, and made every `metadata ->> key` filter match
// nothing. A recording client cannot see it; a live server sees it immediately.
//
// The whole chain runs here: ddl() -> a live server -> upsert -> cosine, FTS and the RRF fusion
// -> decoded hit. Skips unless `TEST_DATABASE_URL` names a server with the `vector` extension
// available, the same gate `pg-driver.live.test.ts` uses; CI's service container sets it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient, raw, sql } from '@ultimat3/db';
import { normalize } from './embeddings';
import { PgVectorStore } from './pg-vector';
import { searchSql } from './pg-vector-sql';
import { fuse, type SearchHit, type VectorRecord } from './vector';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

const TABLE = 'ai_live_docs';
const DROP = `drop table if exists "${TABLE}" cascade`;
const DIMENSION = 4;

const vec = (...values: number[]): Float32Array => normalize(Float32Array.from(values));
const ids = (hits: readonly SearchHit[]): readonly string[] => hits.map((hit) => hit.id);

/** Ties are ordered `score desc, id asc` in SQL; normalise both sides so a tie cannot flake. */
const ranked = (hits: readonly SearchHit[]): readonly string[] =>
  [...hits].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((hit) => hit.id);

const CORPUS: readonly VectorRecord[] = [
  // `x_vector_drift` appears in exactly one document: the rare exact term hybrid search exists
  // for, and the one a pure vector ranking blurs away.
  {
    id: 'a',
    vector: vec(1, 0, 0, 0),
    text: 'alpha guide to x_vector_drift',
    metadata: { kind: 'guide', locale: 'en' },
  },
  {
    id: 'b',
    vector: vec(0.9, 0.1, 0, 0),
    text: 'beta guide about vectors',
    metadata: { kind: 'guide', locale: 'en' },
  },
  {
    id: 'c',
    vector: vec(0, 1, 0, 0),
    text: 'gamma error report',
    metadata: { kind: 'error', locale: 'en' },
  },
  {
    id: 'd',
    vector: vec(0, 0, 1, 0),
    text: 'delta billing summary',
    metadata: { kind: 'billing', locale: 'fr' },
  },
];

describe.skipIf(!hasPostgres)('live · pgvector · PgVectorStore', () => {
  let client: PostgresClient;
  let available = false;
  let store: PgVectorStore;

  beforeAll(async () => {
    client = createPostgresClient({ url: url ?? '' });
    try {
      await client.execute(raw('create extension if not exists vector'));
      available = true;
    } catch {
      // A stock `postgres:*` image has no pgvector. Report it rather than failing every case
      // with an identical "extension vector is not available" — the store is not what broke.
      available = false;
      return;
    }
    await client.execute(raw(DROP));
    store = new PgVectorStore({ name: TABLE, dimension: DIMENSION, client });
    for (const statement of statementsOf(store.ddl())) await client.execute(raw(statement));
    await store.scoped({ tenant: 'acme' }).upsert(CORPUS);
    await store.scoped({ tenant: 'globex' }).upsert([
      // Same id as acme's, deliberately: `(tenant, id)` is the primary key, so this must be a
      // second row and never an overwrite of the other tenant's document.
      {
        id: 'a',
        vector: vec(1, 0, 0, 0),
        text: 'globex alpha x_vector_drift',
        metadata: { kind: 'guide' },
      },
    ]);
  });

  afterAll(async () => {
    if (available) await client.execute(raw(DROP));
    await client.close();
  });

  const acme = (): PgVectorStore => store.scoped({ tenant: 'acme' });

  test('pgvector is installed, so the rest of this file is a real measurement', () => {
    // Deliberately a FAILURE and not a skip. A suite that quietly stands down when the extension
    // is absent reports green for the one store that runs in front of real traffic.
    if (!available) {
      throw new Error(
        'TEST_DATABASE_URL names a Postgres without pgvector, so PgVectorStore is untested.\n' +
          'fix: docker run -d -e POSTGRES_PASSWORD=ultimate -p 5432:5432 pgvector/pgvector:pg17',
      );
    }
    expect(available).toBe(true);
  });

  describe('ddl', () => {
    test('applies twice without erroring — a rerun is a no-op, not 42P07', async () => {
      for (const statement of statementsOf(store.ddl())) await client.execute(raw(statement));
      const rows = await client.query<{ indexname: string }>(
        sql`select indexname from pg_indexes where tablename = ${TABLE} order by indexname`,
      );
      expect(rows.map((row) => row.indexname)).toEqual([
        `${TABLE}_embedding_idx`,
        `${TABLE}_metadata_idx`,
        `${TABLE}_pkey`,
        `${TABLE}_tsv_idx`,
      ]);
    });

    test('the generated tsvector column is populated by the server, not by the writer', async () => {
      const [row] = await client.query<{ tsv: string }>(
        sql`select "tsv"::text as tsv from ${raw(`"${TABLE}"`)} where "tenant" = 'acme' and "id" = 'a'`,
      );
      // 'guide' stemmed to 'guid': the english regconfig really ran, and `simple` would have
      // left it whole. The parser splits on `_` exactly as the memory store's tokenizer does.
      expect(row?.tsv).toContain("'guid'");
      expect(row?.tsv).toContain("'drift'");
    });
  });

  describe('writes', () => {
    test('metadata round-trips as an object, so `->>` filters actually match', async () => {
      // The `::text::jsonb` regression: a bound string cast straight to jsonb lands as a jsonb
      // *string*, reads back correctly through `->>`-free paths, and matches nothing here.
      const [row] = await client.query<{ typeof: string; kind: string | null }>(
        sql`select jsonb_typeof("metadata") as typeof, "metadata" ->> 'kind' as kind
            from ${raw(`"${TABLE}"`)} where "tenant" = 'acme' and "id" = 'a'`,
      );
      expect(row?.typeof).toBe('object');
      expect(row?.kind).toBe('guide');
      const hits = await acme().search(vec(1, 0, 0, 0), 10, { kind: 'guide' });
      expect(ids(hits).sort()).toEqual(['a', 'b']);
    });

    test('upsert of an existing id replaces the row instead of adding a second', async () => {
      const scoped = acme();
      await scoped.upsert([
        {
          id: 'a',
          vector: vec(1, 0, 0, 0),
          text: 'alpha guide to x_vector_drift',
          metadata: { kind: 'guide', locale: 'en' },
        },
      ]);
      const [row] = await client.query<{ count: string }>(
        sql`select count(*)::text as count from ${raw(`"${TABLE}"`)} where "tenant" = 'acme' and "id" = 'a'`,
      );
      expect(row?.count).toBe('1');
    });

    test('`(tenant, id)` is the key, so one tenant can never overwrite another tenant’s row', async () => {
      const [mine] = await acme().search(vec(1, 0, 0, 0), 1);
      const [theirs] = await store.scoped({ tenant: 'globex' }).search(vec(1, 0, 0, 0), 1);
      expect(mine?.text).toBe('alpha guide to x_vector_drift');
      expect(theirs?.text).toBe('globex alpha x_vector_drift');
    });
  });

  describe('reads', () => {
    test('search ranks by real cosine similarity on the 1 - distance scale', async () => {
      const hits = await acme().search(vec(1, 0, 0, 0), 4);
      expect(ids(hits)).toEqual(['a', 'b', 'c', 'd']);
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      // Orthogonal vectors: cosine 0, so the score is the same number the memory store returns.
      expect(hits[2]?.score).toBeCloseTo(0, 5);
    });

    test('searchText is Postgres FTS: the rare exact term wins and stemming applies', async () => {
      expect(ids(await acme().searchText('x_vector_drift', 5))).toEqual(['a']);
      // 'guides' stems to 'guide', which is the whole point of running FTS rather than LIKE.
      expect(ids(await acme().searchText('guides', 5)).sort()).toEqual(['a', 'b']);
      expect(await acme().searchText('nothing matches this', 5)).toEqual([]);
    });

    test('hybrid fuses in SQL exactly as fuse() does in memory — dev and prod order alike', async () => {
      const scoped = acme();
      const input = { query: 'guide x_vector_drift', vector: vec(0, 1, 0, 0), k: 4 };
      const width = Math.max(input.k * 4, 20);
      const [dense, lexical] = await Promise.all([
        scoped.search(input.vector, width),
        scoped.searchText(input.query, width),
      ]);
      const hybrid = await scoped.hybrid(input);
      expect(ranked(hybrid)).toEqual(ranked(fuse([dense, lexical]).slice(0, input.k)));
      // The lexical winner beats the doc that merely leads a flat dense ranking.
      expect(hybrid[0]?.id).toBe('a');
      expect(ids(hybrid)).toContain('c');
    });

    test('hybrid honours a declared candidate width and rrfK', async () => {
      const hits = await acme().hybrid({
        query: 'guide',
        vector: vec(1, 0, 0, 0),
        k: 2,
        candidates: 3,
        rrfK: 1,
      });
      expect(hits).toHaveLength(2);
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
    });
  });

  describe('scope', () => {
    test('a tenant sees only its own rows, on every read path', async () => {
      const scoped = acme();
      expect(ids(await scoped.search(vec(1, 0, 0, 0), 10))).not.toContain('globex-only');
      for (const hits of [
        await scoped.search(vec(1, 0, 0, 0), 10),
        await scoped.searchText('x_vector_drift', 10),
        await scoped.hybrid({ query: 'x_vector_drift', vector: vec(1, 0, 0, 0), k: 10 }),
      ]) {
        expect(hits.every((hit) => !hit.text.startsWith('globex'))).toBe(true);
      }
    });

    test('the policy allow-list filters BOTH halves of the fusion, not just the dense one', async () => {
      // 'd' is the only lexical match for 'billing' and is outside the allow-list. An
      // unfiltered lexical CTE would fuse it back in — the leak the two `where` clauses close.
      const scoped = acme().scoped({ allow: { kind: ['guide'] } });
      const hits = await scoped.hybrid({
        query: 'billing summary',
        vector: vec(0, 0, 1, 0),
        k: 10,
      });
      expect(ids(hits)).not.toContain('d');
      expect(ids(await scoped.searchText('billing summary', 10))).toEqual([]);
      expect(ids(await scoped.search(vec(0, 0, 1, 0), 10)).sort()).toEqual(['a', 'b']);
    });

    test('an empty allow-list matches nothing rather than everything', async () => {
      const scoped = acme().scoped({ allow: { kind: [] } });
      expect(await scoped.search(vec(1, 0, 0, 0), 10)).toEqual([]);
      expect(await scoped.hybrid({ query: 'guide', vector: vec(1, 0, 0, 0), k: 10 })).toEqual([]);
    });

    test('delete carries the scope: another tenant’s identical id survives', async () => {
      const scoped = store.scoped({ tenant: 'acme' });
      await scoped.upsert([{ id: 'doomed', vector: vec(0, 0, 0, 1), text: 'doomed row' }]);
      await store.scoped({ tenant: 'globex' }).delete(['doomed', 'a']);
      expect(ids(await scoped.search(vec(0, 0, 0, 1), 1))).toEqual(['doomed']);
      expect(ids(await store.scoped({ tenant: 'globex' }).search(vec(1, 0, 0, 0), 5))).toEqual([]);
      await scoped.delete(['doomed']);
      expect(ids(await scoped.search(vec(0, 0, 0, 1), 5))).not.toContain('doomed');
    });
  });

  describe('index', () => {
    const target = { table: TABLE, dimension: DIMENSION, language: 'english' };
    const planOf = async (statement: ReturnType<typeof searchSql>): Promise<string> =>
      JSON.stringify(
        await client.query<Record<string, unknown>>(sql`explain (format json) ${statement}`),
      );

    beforeAll(async () => {
      if (!available) return;
      await client.execute(
        raw(`insert into "${TABLE}" ("tenant", "id", "embedding", "content")
             select 'bulk', 'bulk-' || i,
               ('[' || sin(i)::text || ',' || cos(i)::text || ',' ||
                       sin(i * 2)::text || ',' || cos(i * 2)::text || ']')::vector,
               'bulk document ' || i
             from generate_series(1, 5000) i
             on conflict do nothing`),
      );
      // Without stats the planner sizes every tenant at the default guess and picks the exact
      // path for all of them, which is a correct answer and a slow one. `x db migrate` analyzes;
      // a bulk backfill that skips it is why a search that used the index yesterday scans today.
      await client.execute(raw(`analyze "${TABLE}"`));
    });

    test('the search this store emits is answered by the hnsw index', async () => {
      const plan = await planOf(searchSql(target, vec(1, 0, 0, 0), { scope: {}, k: 10 }));
      expect(plan).toContain(`${TABLE}_embedding_idx`);
      expect(plan).not.toContain('Seq Scan');
    });

    test('ordering by `1 - distance` descending instead would be a sequential scan', async () => {
      // The negative half, and the whole reason the distance ordering sits in a subquery: hnsw
      // answers `order by embedding <=> $1` and nothing else. Only a planner can say which
      // shipped, so the shape this store avoids is pinned here rather than in a comment.
      const plan = await planOf(
        sql`select "id", 1 - ("embedding" <=> ${'[1,0,0,0]'}::vector) as score
            from ${raw(`"${TABLE}"`)} order by score desc limit 10`,
      );
      expect(plan).toContain('Seq Scan');
      expect(plan).not.toContain(`${TABLE}_embedding_idx`);
    });

    test('a tenant read stays complete: the filter never silently shortens the page', async () => {
      // hnsw applies the scope AFTER the index scan, so a small tenant inside a large table is
      // where an approximate index quietly returns fewer rows than asked for. The planner takes
      // the exact path when the filter is that selective — assert the ROWS, never the node.
      const hits = await acme().search(vec(1, 0, 0, 0), 4);
      expect(ids(hits)).toEqual(['a', 'b', 'c', 'd']);
    });
  });
});

/** One `execute` runs one statement; `ddl()` is a script. No generated clause holds a `;\n`. */
function statementsOf(script: string): readonly string[] {
  return script
    .split(';\n')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
