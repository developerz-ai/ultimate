import { describe, expect, test } from 'bun:test';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { asyncRefusal } from './bounds-fixture';
import { normalize } from './embeddings';
import { PgVectorStore } from './pg-vector';
import { conditionsSql, vectorLiteral } from './pg-vector-sql';

const vec = (...values: number[]): Float32Array => normalize(Float32Array.from(values));

interface Harness {
  readonly client: RecordingClient;
  readonly store: PgVectorStore;
}

function harness(): Harness {
  const client = createRecordingClient();
  return { client, store: new PgVectorStore({ name: 'docs', dimension: 4, client }) };
}

const codeOf = (error: unknown): string =>
  (error as { code?: string } | undefined)?.code ?? String(error);

describe('PgVectorStore ddl', () => {
  test('one table, a composite tenant key and both indexes the queries need', () => {
    const ddl = new PgVectorStore({ name: 'docs', dimension: 1536 }).ddl();
    expect(ddl).toContain('create extension if not exists vector;');
    expect(ddl).toContain('embedding vector(1536) not null');
    // The key is (tenant, id), so one tenant can never overwrite another tenant's row by id.
    expect(ddl).toContain('primary key (tenant, id)');
    expect(ddl).toContain('using hnsw (embedding vector_cosine_ops)');
    expect(ddl).toContain('using gin (tsv)');
    expect(ddl).toContain("to_tsvector('english', content)");
  });

  test('the FTS language is the one the queries bind, not a second default', async () => {
    const client = createRecordingClient();
    const store = new PgVectorStore({ name: 'docs', dimension: 4, client, language: 'simple' });
    expect(store.ddl()).toContain("to_tsvector('simple', content)");
    await store.searchText('x_db_drift', 5);
    expect(client.statements[0]?.values).toContain('simple');
  });
});

describe('PgVectorStore writes', () => {
  test('upsert is one multi-row statement that stamps the scope tenant', async () => {
    const { client, store } = harness();
    await store.scoped({ tenant: 'acme' }).upsert([
      { id: 'a', vector: vec(1, 0, 0, 0), text: 'alpha', metadata: { kind: 'guide' } },
      { id: 'b', vector: vec(0, 1, 0, 0), text: 'beta' },
    ]);
    expect(client.statements).toHaveLength(1);
    const [statement] = client.statements;
    expect(client.texts[0]).toContain('on conflict ("tenant", "id") do update set');
    expect(statement?.values.filter((value) => value === 'acme')).toHaveLength(2);
    expect(statement?.values).toContain(vectorLiteral(vec(1, 0, 0, 0)));
    expect(statement?.values).toContain('{"kind":"guide"}');
    expect(statement?.values).toContain('{}');
  });

  test('metadata is cast ::text::jsonb, so it lands as an object and not a jsonb string', async () => {
    const { client, store } = harness();
    await store.upsert([{ id: 'a', vector: vec(1, 0, 0, 0), text: 'alpha', metadata: { k: 'v' } }]);
    // A bound string cast straight to jsonb is JSON-encoded twice: it reads back correctly and
    // every `metadata ->> key` filter then matches nothing. Silent, and only visible live.
    expect(client.texts[0]).toContain('::text::jsonb');
    expect(client.texts[0]).not.toMatch(/[^t]::jsonb/);
  });

  test('an empty upsert and an empty delete emit no statement at all', async () => {
    const { client, store } = harness();
    await store.upsert([]);
    await store.delete([]);
    expect(client.statements).toHaveLength(0);
  });

  test('a vector of the wrong length is refused before any statement runs', async () => {
    const { client, store } = harness();
    expect(
      codeOf(await store.upsert([{ id: 'a', vector: vec(1, 0), text: 'x' }]).catch((e) => e)),
    ).toBe('X_VECTOR_DIM_MISMATCH');
    expect(codeOf(await store.search(vec(1, 0, 0), 3).catch((e) => e))).toBe(
      'X_VECTOR_DIM_MISMATCH',
    );
    expect(client.statements).toHaveLength(0);
  });

  test('delete carries the scope, so a tenant cannot delete another tenant’s id', async () => {
    const { client, store } = harness();
    await store.scoped({ tenant: 'acme' }).delete(['a', 'b']);
    expect(client.texts[0]).toContain(
      'delete from "docs" where "id" in ($1, $2) and "tenant" = $3',
    );
    expect(client.statements[0]?.values).toEqual(['a', 'b', 'acme']);
  });
});

describe('PgVectorStore reads', () => {
  test('search orders by raw cosine distance ascending, so hnsw can answer it', async () => {
    const { client, store } = harness();
    await store.search(vec(1, 0, 0, 0), 5);
    const text = client.texts[0] ?? '';
    expect(text).toContain('"embedding" <=> $1::vector as distance');
    expect(text).toContain('order by distance limit $2');
    expect(text).toContain('1 - distance as score');
    expect(client.statements[0]?.values[1]).toBe(5);
  });

  test('searchText is Postgres FTS, matched and ranked by the same tsquery', async () => {
    const { client, store } = harness();
    await store.searchText('x_db_drift schema', 3);
    const text = client.texts[0] ?? '';
    expect(text).toContain('websearch_to_tsquery($1::regconfig, $2) q');
    expect(text).toContain('where "tsv" @@ q');
    expect(text).toContain('ts_rank_cd("tsv", q) as score');
    expect(client.statements[0]?.values).toEqual(['english', 'x_db_drift schema', 3]);
  });

  test('hybrid fuses both rankings in SQL with the same 1/(k+rank) the memory store uses', async () => {
    const { client, store } = harness();
    await store.hybrid({ query: 'drift', vector: vec(1, 0, 0, 0), k: 5 });
    const text = client.texts[0] ?? '';
    expect(text).toContain('with dense as (');
    expect(text).toContain('), lexical as (');
    expect(text).toContain('union all');
    expect(text).toContain('sum(1.0 / ($6 + rank))::double precision as score');
    expect(text).toContain('join "docs" d on d."tenant" = f."tenant" and d."id" = f."id"');
    // Defaults: rrfK 60, candidate width max(k * 4, 20), final limit k.
    expect(client.statements[0]?.values).toEqual([
      vectorLiteral(vec(1, 0, 0, 0)),
      20,
      'english',
      'drift',
      20,
      60,
      5,
    ]);
  });

  test('candidates and rrfK are honoured when declared', async () => {
    const { client, store } = harness();
    await store.hybrid({
      query: 'drift',
      vector: vec(1, 0, 0, 0),
      k: 2,
      candidates: 50,
      rrfK: 10,
    });
    expect(client.statements[0]?.values).toEqual([
      vectorLiteral(vec(1, 0, 0, 0)),
      50,
      'english',
      'drift',
      50,
      10,
      2,
    ]);
  });

  test('rows decode whether the driver parses jsonb or hands back text', async () => {
    const { client, store } = harness();
    client.on('select', {
      rows: [
        { id: 'a', content: 'alpha', metadata: { kind: 'guide' }, score: 0.9 },
        { id: 'b', content: 'beta', metadata: '{"kind":"error"}', score: '0.5' },
        { id: 'c', content: 'gamma', metadata: null, score: 0.1 },
      ],
    });
    const hits = await store.search(vec(1, 0, 0, 0), 3);
    expect(hits.map((hit) => hit.id)).toEqual(['a', 'b', 'c']);
    expect(hits[1]).toEqual({ id: 'b', score: 0.5, text: 'beta', metadata: { kind: 'error' } });
    expect(hits[2]?.metadata).toEqual({});
  });

  test('with no client the ambient db() is used, so a store joins the caller’s transaction', async () => {
    const client = createRecordingClient();
    setDbClient(client);
    try {
      await new PgVectorStore({ name: 'docs', dimension: 4 }).searchText('drift', 1);
      expect(client.statements).toHaveLength(1);
    } finally {
      setDbClient(undefined);
    }
  });
});

describe('PgVectorStore scope', () => {
  test('the tenant and the policy allow-list land in SQL, never in the text', async () => {
    const { client, store } = harness();
    const scoped = store.scoped({
      tenant: "acme'; drop table docs; --",
      allow: { kind: ['guide'] },
    });
    await scoped.search(vec(1, 0, 0, 0), 5, { locale: 'en' });
    const text = client.texts[0] ?? '';
    expect(text).toContain(
      '"tenant" = $2 and "metadata" ->> $3 in ($4) and "metadata" ->> $5 = $6',
    );
    expect(text).not.toContain('drop table');
    expect(client.statements[0]?.values).toEqual([
      vectorLiteral(vec(1, 0, 0, 0)),
      "acme'; drop table docs; --",
      'kind',
      'guide',
      'locale',
      'en',
      5,
    ]);
  });

  test('hybrid applies the scope to BOTH rankings — one unfiltered CTE would leak', async () => {
    const { client, store } = harness();
    await store
      .scoped({ tenant: 'acme' })
      .hybrid({ query: 'drift', vector: vec(1, 0, 0, 0), k: 5 });
    const text = client.texts[0] ?? '';
    expect(text.split('"tenant" = $').length - 1).toBe(2);
    expect(client.statements[0]?.values.filter((value) => value === 'acme')).toHaveLength(2);
  });

  test('an empty allow-list matches nothing rather than everything', () => {
    expect(conditionsSql({ allow: { kind: [] } }).text).toBe('1 = 0');
    expect(conditionsSql({}).text).toBe('true');
  });

  test('scoping tightens: allow-lists intersect and a new key is added', () => {
    const store = new PgVectorStore({ name: 'docs', dimension: 4 });
    const scoped = store
      .scoped({ allow: { kind: ['guide', 'error'] } })
      .scoped({ allow: { kind: ['error', 'billing'], locale: ['en'] } });
    expect(scoped.scope.allow).toEqual({ kind: ['error'], locale: ['en'] });
  });

  test('a scoped store cannot be re-scoped to another tenant', () => {
    const scoped = new PgVectorStore({ name: 'docs', dimension: 4 }).scoped({ tenant: 'acme' });
    expect(scoped.scoped({ tenant: 'acme' }).scope.tenant).toBe('acme');
    let thrown: unknown;
    try {
      scoped.scoped({ tenant: 'other' });
    } catch (error) {
      thrown = error;
    }
    expect(codeOf(thrown)).toBe('X_VECTOR_SCOPE_WIDENED');
    expect((thrown as { fix?: string }).fix).toContain("scoped({ tenant: 'other' })");
  });
});

/**
 * The production store screens the same three bounds as its in-memory twin, and it has to: they
 * reach Postgres as bound parameters, so an unscreened one is either the database's error to
 * report — about a `limit`, naming nothing a caller wrote — or, for `rrfK`, no error at all.
 * Postgres float8 HAS a `NaN`, it sorts as the largest value, so every fused score ties and the
 * ranking collapses to the id tiebreak with a full result list still coming back.
 */
describe('PgVectorStore refuses a bound before it opens a connection', () => {
  test('k, candidates and rrfK are named, and no statement is issued', async () => {
    const { client, store } = harness();
    const query = { query: 'drift', vector: vec(1, 0, 0, 0) };
    expect((await asyncRefusal(() => store.hybrid({ ...query, k: Number.NaN }))).cause).toContain(
      'k',
    );
    expect(
      (await asyncRefusal(() => store.hybrid({ ...query, k: 5, candidates: Number.NaN }))).cause,
    ).toContain('candidates');
    expect(
      (await asyncRefusal(() => store.hybrid({ ...query, k: 5, rrfK: Number.NaN }))).cause,
    ).toContain('rrfK');
    expect((await asyncRefusal(() => store.search(vec(1, 0, 0, 0), Number.NaN))).cause).toContain(
      'k',
    );
    expect((await asyncRefusal(() => store.searchText('drift', 2.5))).cause).toContain('k');
    // The point of screening here rather than letting the driver answer: nothing was sent.
    expect(client.statements).toHaveLength(0);
  });

  test('an honest hybrid read still builds its statement — the non-vacuity half', async () => {
    const { client, store } = harness();
    await store.hybrid({ query: 'drift', vector: vec(1, 0, 0, 0), k: 5 });
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0]?.values).toContain(60);
  });
});
