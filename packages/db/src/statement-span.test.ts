// Single responsibility: tests for the span one statement is — its name, the text it carries, and
// the proof that both funnels open exactly one per statement and none at all with no observer
// installed. Asserted against core's REAL tracer, never a hand-built `ReadableSpan`: the bug this
// closes is a `/_x` timeline whose `repeatedSql` reads an attribute nothing actually emits.

import { afterEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import { configureTelemetry, memoryExporter, resetTelemetry, withSpan } from '@ultimat3/core';
import { createPostgresClient } from './client';
import { setStatementObserver } from './observe';
import { createPgliteClient, type PgliteDriver } from './pglite';
import { sql } from './sql';
import { statementSpanName, withStatementSpan } from './statement-span';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

/** Enough `Bun.SQL` to answer one statement — the funnel is under test here, not the pool. */
function installFakeSql(): void {
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return [];
    }
    async close(): Promise<void> {}
  };
}

const fakeDriver = (): PgliteDriver => ({
  query: async () => ({ rows: [] }),
  close: async () => undefined,
});

/** Spans this test observed, in export order. Exporting is the only way one leaves the tracer. */
function traced(): { readonly spans: readonly ReadableSpan[] } {
  const exporter = memoryExporter();
  configureTelemetry({ exporter });
  return exporter;
}

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // All three are process-wide: leaving any installed makes every later test run under this one's.
  setStatementObserver(undefined);
  resetTelemetry();
});

describe('unit · the statement span', () => {
  test('is named for the statement verb, so a flame reads without opening a row', () => {
    expect(statementSpanName('select id from members where org = $1')).toBe('db.select');
    expect(statementSpanName('INSERT INTO members (id) VALUES ($1)')).toBe('db.insert');
    expect(statementSpanName('\n  BEGIN')).toBe('db.begin');
  });

  test('falls back to db.statement when the text opens with something that is not a word', () => {
    // A leading comment still traces, still counts and still carries its text — only the label is
    // generic, which is the trade for not running a second SQL scanner per statement.
    expect(statementSpanName('/* app=web */ select 1')).toBe('db.statement');
    expect(statementSpanName('')).toBe('db.statement');
  });

  test('carries the whole text as db.statement, which is what the panel groups on', async () => {
    const exporter = traced();
    await withStatementSpan('select id from members where org = $1', async () => undefined);

    expect(exporter.spans[0]?.attributes['db.statement']).toBe(
      'select id from members where org = $1',
    );
    // OTel's kind: the database is the remote peer. The panel's own `sql` kind is the name prefix.
    expect(exporter.spans[0]?.kind).toBe('client');
  });

  test('records the failure on the span and still throws it', async () => {
    const exporter = traced();
    const failure = new Error('deadlock detected');

    await expect(
      withStatementSpan('update members set name = $1', () => Promise.reject(failure)),
    ).rejects.toThrow('deadlock detected');

    expect(exporter.spans[0]?.status.code).toBe('error');
    expect(exporter.spans[0]?.events[0]?.name).toBe('exception');
  });

  test('nests under the caller, so a statement lands inside the request that ran it', async () => {
    const exporter = traced();
    await withSpan('GET /feed', async () => {
      await withStatementSpan('select 1', async () => undefined);
    });

    // Innermost ends first, so the statement is exported before the request that contains it.
    const [statement, request] = exporter.spans;
    expect(statement?.name).toBe('db.select');
    expect(statement?.parentSpanId).toBe(request?.context.spanId);
  });
});

describe('unit · the funnels open exactly one per statement', () => {
  test('the pooled client traces an observed statement', async () => {
    const exporter = traced();
    setStatementObserver({ onStatement: () => undefined });
    installFakeSql();

    await createPostgresClient({ url: TEST_URL }).query(sql`select id from members`);

    expect(exporter.spans.map((span) => span.name)).toEqual(['db.select']);
    expect(exporter.spans[0]?.attributes['db.statement']).toBe('select id from members');
  });

  test('the embedded client traces an observed statement', async () => {
    const exporter = traced();
    setStatementObserver({ onStatement: () => undefined });

    await createPgliteClient({ driver: fakeDriver() }).query(sql`select id from posts`);

    expect(exporter.spans.map((span) => span.name)).toEqual(['db.select']);
    expect(exporter.spans[0]?.attributes['db.statement']).toBe('select id from posts');
  });

  // The production path: an exporter configured and no diagnostic installed traces exactly what it
  // traced before this seam existed — no id minted, no span object, no export call per statement.
  test('neither traces anything with no observer installed', async () => {
    const exporter = traced();
    installFakeSql();

    await createPostgresClient({ url: TEST_URL }).query(sql`select 1`);
    await createPgliteClient({ driver: fakeDriver() }).query(sql`select 1`);

    expect(exporter.spans).toEqual([]);
  });
});
