/**
 * Where an audited read is recorded from, and what a memo hit and a refusing sink do. Every
 * projection is driven through its real entry — the HTTP pipeline, the MCP descriptor, the
 * `sourceFor` + `execute()` pair `@ultimat3/mcp`'s served tool makes, `.page()` — and each must
 * produce exactly ONE record per call, naming its surface the way an action's record names it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { isolateTiers, lruTier, registerTier } from '@ultimat3/cache';
import type { AuditRecord, AuditSink } from '@ultimat3/core';
import { ctxOf, isUltimateError, resetAuditSink, setAuditSink, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toQueryRoute } from './http';
import { query } from './query';
import { runQuery, sourceFor } from './read';
import { resetQueries } from './registry';
import { from } from './source';
import { explainQuery } from './sql';

interface Row {
  readonly id: string;
}

const reader: PolicyActor = {
  ...userActor({ id: 'u1', orgId: 'org-1' }),
  permissions: ['post:read'],
};
const stranger: PolicyActor = { ...userActor({ id: 'u2', orgId: 'org-1' }), permissions: [] };

const collecting = (): AuditSink & { readonly records: AuditRecord[] } => {
  const records: AuditRecord[] = [];
  return { records, write: (record) => void records.push(record) };
};

let executed = 0;

const postList = (cached = false) =>
  query({
    input: t.object({ limit: t.number.int().min(1).max(50) }),
    policy: can('post:read'),
    audit: true,
    ...(cached ? { cache: { tags: [{ entity: 'posts' }] } } : {}),
    sql: () =>
      from<Row>('posts', () => {
        executed += 1;
        return [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      }).orderBy('id', 'asc'),
  }).named('postList');

let restoreTiers: (() => void) | undefined;

afterEach(() => {
  resetQueries();
  resetAuditSink();
  restoreTiers?.();
  restoreTiers = undefined;
  executed = 0;
});

describe('unit · every surface records once, under its own name', () => {
  test('over HTTP, through the real pipeline: surface http', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const server = httpServer({
      routes: [toQueryRoute(postList())],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => reader },
    });

    const response = await server.fetch(
      new Request('http://dev.test/_x/query/post-list?limit=2', { method: 'GET' }),
    );

    expect(response.status).toBe(200);
    expect(sink.records.map((record) => record.surface)).toEqual(['http']);
    // The ROUTE coerces the search string; the record carries the parse, a number and not "2".
    expect(sink.records[0]?.input).toEqual({ limit: 2 });
  });

  test('a denied HTTP read is recorded too — the 403 still reaches the caller', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const server = httpServer({
      routes: [toQueryRoute(postList())],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => stranger },
    });

    const response = await server.fetch(
      new Request('http://dev.test/_x/query/post-list?limit=2', { method: 'GET' }),
    );

    expect(response.status).toBe(403);
    expect(sink.records.map((record) => [record.surface, record.outcome])).toEqual([
      ['http', 'denied'],
    ]);
  });

  test("@ultimat3/mcp's served tool — sourceFor, then execute() — is one mcp record", async () => {
    const sink = collecting();
    setAuditSink(sink);

    const source = await sourceFor(
      postList(),
      { limit: 2 },
      {
        surface: 'mcp',
        ctx: ctxOf({ actor: reader }),
      },
    );
    expect(sink.records).toEqual([]);
    await source.execute();

    expect(sink.records.map((record) => [record.surface, record.input])).toEqual([
      ['mcp', { limit: 2 }],
    ]);
  });

  test('a sourceFor build that is refused is recorded at once — no execute() will follow', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await expect(
      sourceFor(
        postList(),
        { limit: 2 },
        {
          surface: 'mcp',
          ctx: ctxOf({ actor: stranger }),
        },
      ),
    ).rejects.toThrow();

    expect(sink.records.map((record) => [record.surface, record.outcome])).toEqual([
      ['mcp', 'denied'],
    ]);
  });

  test('.page() is one call and one record, its seek push-down included', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = ctxOf({ actor: reader });

    const page = await postList().page({ limit: 2 }, { first: 2, ctx });
    await postList().page(
      { limit: 2 },
      { first: 2, ctx, ...(page.nextCursor === null ? {} : { after: page.nextCursor }) },
    );

    expect(page.rows).toHaveLength(2);
    expect(sink.records.map((record) => [record.surface, record.outcome, record.replayed])).toEqual(
      [
        ['server', 'allowed', false],
        ['server', 'allowed', false],
      ],
    );
  });

  test('.as() is the server surface under the impersonated actor', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await postList().as(reader, { limit: 1 });

    expect(sink.records[0]?.surface).toBe('server');
    expect(sink.records[0]?.ctx.actor.id).toBe('u1');
  });

  test('explainQuery() is unenforced and reads no row: not recorded, and needs no sink', async () => {
    const plan = await explainQuery(postList(), { limit: 2 }, ctxOf({ actor: reader }));
    expect(plan.query).toBe('postList');
  });
});

describe('unit · a memo or cache hit is still a sighting', () => {
  test('the request memo: two records, one execution, the second replayed', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = ctxOf({ actor: reader });

    await runQuery(postList(), { limit: 2 }, { ctx });
    await runQuery(postList(), { limit: 2 }, { ctx });

    expect(executed).toBe(1);
    expect(sink.records.map((record) => record.replayed)).toEqual([false, true]);
  });

  test('two concurrent identical reads join one execution and are two records', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = ctxOf({ actor: reader });

    await Promise.all([
      runQuery(postList(), { limit: 2 }, { ctx }),
      runQuery(postList(), { limit: 2 }, { ctx }),
    ]);

    expect(executed).toBe(1);
    expect(sink.records.map((record) => record.replayed).sort()).toEqual([false, true]);
  });

  test('a cache tier hit in a second request: recorded, replayed', async () => {
    restoreTiers = isolateTiers();
    registerTier(lruTier());
    const sink = collecting();
    setAuditSink(sink);

    await runQuery(postList(true), { limit: 2 }, { ctx: ctxOf({ actor: reader }) });
    await runQuery(postList(true), { limit: 2 }, { ctx: ctxOf({ actor: reader }) });

    expect(executed).toBe(1);
    expect(sink.records.map((record) => record.replayed)).toEqual([false, true]);
    expect(sink.records[0]?.ctx.requestId).not.toBe(sink.records[1]?.ctx.requestId);
  });

  test('fresh: true executes, so it is not replayed', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = ctxOf({ actor: reader });

    await runQuery(postList(), { limit: 2 }, { ctx });
    await runQuery(postList(), { limit: 2 }, { ctx, fresh: true });

    expect(sink.records.map((record) => record.replayed)).toEqual([false, false]);
  });
});

describe('unit · a sink that refuses is never swallowed', () => {
  // The sink's failure is input to the code under test, not a verdict: it is built once and thrown.
  const gone = new TypeError('audit table is gone');
  const refusing: AuditSink = {
    write: (): never => {
      throw gone;
    },
  };

  test('an allowed read whose record is refused withholds the rows: X_QUERY_AUDIT_SINK_FAILED', async () => {
    setAuditSink(refusing);

    const error = await runQuery(
      postList(),
      { limit: 2 },
      {
        ctx: ctxOf({ actor: reader }),
      },
    ).then(
      () => expect.unreachable('rows nobody recorded were handed back'),
      (caught: unknown) => caught,
    );

    expect(isUltimateError(error) && error.code).toBe('X_QUERY_AUDIT_SINK_FAILED');
  });

  test('a denied read whose record is refused still answers with the DENIAL', async () => {
    setAuditSink(refusing);

    const error = await runQuery(
      postList(),
      { limit: 2 },
      {
        ctx: ctxOf({ actor: stranger }),
      },
    ).then(
      () => expect.unreachable('a stranger was answered'),
      (caught: unknown) => caught,
    );

    expect(isUltimateError(error) && error.code).not.toBe('X_QUERY_AUDIT_SINK_FAILED');
    expect(isUltimateError(error) && error.code).toMatch(/^X_(FORBIDDEN|UNAUTHENTICATED)$/);
  });
});
