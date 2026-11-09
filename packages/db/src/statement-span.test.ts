// Single responsibility: tests for the span one statement is — its name, the stable OTel attributes
// it carries, and the proof that both funnels open exactly one per statement with NO `db.statement`
// subscriber (production has DB spans) while building no bus event for nobody. Asserted against
// core's REAL tracer, through `span.end`, never a hand-built `ReadableSpan`.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  captureStatementStacks,
  resetInstrumentation,
  resetStatementStacks,
  resetTelemetry,
  subscribe,
  withSpan,
} from '@ultimat3/core';
import { postgresClient } from './client';
import { type PgliteDriver, pgliteClient } from './pglite';
import { sql } from './sql';
import { statementSpanName, withStatementSpan } from './statement-span';

const TEST_URL = 'postgres://app@127.0.0.1:5432/ultimate_test';

const host = globalThis as unknown as { Bun: { SQL: unknown } };
const realBunSql = host.Bun.SQL;

/** Enough `Bun.SQL` to answer one statement — the funnel is under test here, not the pool. */
function installFakeSql(rows: readonly unknown[] = []): void {
  host.Bun.SQL = class {
    async unsafe(): Promise<unknown> {
      return rows;
    }
    async close(): Promise<void> {}
  };
}

const fakeDriver = (): PgliteDriver => ({
  query: async () => ({ rows: [] }),
  close: async () => undefined,
});

/** Sampled spans, in end order — `span.end` is the only way one leaves the tracer. */
function traced(): readonly ReadableSpan[] {
  const spans: ReadableSpan[] = [];
  subscribe('span.end', (event) => void spans.push(event.payload));
  return spans;
}

let clock: ReturnType<typeof spyOn<Performance, 'now'>> | undefined;

afterEach(() => {
  host.Bun.SQL = realBunSql;
  // Process-wide, both: leaving either installed makes every later test run under this one's.
  resetInstrumentation();
  resetStatementStacks();
  resetTelemetry();
  clock?.mockRestore();
  clock = undefined;
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

  test('carries the stable semconv names, and never the old db.statement attribute', async () => {
    const spans = traced();
    await withStatementSpan('select id from members where org = $1', async () => undefined);

    expect(spans[0]?.attributes).toEqual({
      'db.system.name': 'postgresql',
      'db.query.text': 'select id from members where org = $1',
      'db.operation.name': 'SELECT',
    });
    expect(spans[0]?.attributes).not.toHaveProperty('db.statement');
    // OTel's kind: the database is the remote peer. The panel's own `sql` kind is the name prefix.
    expect(spans[0]?.kind).toBe('client');
  });

  test('omits db.operation.name when the text has no leading verb', async () => {
    const spans = traced();
    await withStatementSpan('/* app=web */ select 1', async () => undefined);
    expect(spans[0]?.attributes).not.toHaveProperty('db.operation.name');
  });

  test('records the failure on the span and still throws it', async () => {
    const spans = traced();
    const failure = new Error('deadlock detected');

    await expect(
      withStatementSpan('update members set name = $1', () => Promise.reject(failure)),
    ).rejects.toThrow('deadlock detected');

    expect(spans[0]?.status.code).toBe('error');
    expect(spans[0]?.events[0]?.name).toBe('exception');
  });

  test('nests under the caller, so a statement lands inside the request that ran it', async () => {
    const spans = traced();
    await withSpan('GET /feed', async () => {
      await withStatementSpan('select 1', async () => undefined);
    });

    // Innermost ends first, so the statement is exported before the request that contains it.
    const [statement, request] = spans;
    expect(statement?.name).toBe('db.select');
    expect(statement?.parentSpanId).toBe(request?.context.spanId);
  });
});

describe('unit · the funnels open exactly one per statement, subscriber or not', () => {
  test('the pooled client traces a statement with no db.statement subscriber', async () => {
    const spans = traced();
    installFakeSql();

    await postgresClient({ url: TEST_URL }).query(sql`select id from members`);

    expect(spans.map((span) => span.name)).toEqual(['db.select']);
    expect(spans[0]?.attributes['db.query.text']).toBe('select id from members');
  });

  test('the embedded client traces a statement with no db.statement subscriber', async () => {
    const spans = traced();

    await pgliteClient({ driver: fakeDriver() }).query(sql`select id from posts`);

    expect(spans.map((span) => span.name)).toEqual(['db.select']);
    expect(spans[0]?.attributes['db.query.text']).toBe('select id from posts');
  });

  test('a db.statement subscriber adds no second span', async () => {
    const spans = traced();
    subscribe('db.statement', () => undefined);
    installFakeSql();

    await postgresClient({ url: TEST_URL }).query(sql`select 1`);

    expect(spans.map((span) => span.name)).toEqual(['db.select']);
  });
});

// Axiom 6 on the event half: with nobody subscribed to `db.statement` the funnel reads no clock
// for a duration — the first thing it does once it decides to build an event. The tracer reads the
// clock for the span either way, so the proof is the DIFFERENCE: exactly the two reads (start,
// settle) an event costs, and none without a subscriber.
// Production subscribes (`subscribeSemconvMetrics`) but never holds stack capture: a stack per
// statement is cost nobody there reads. Only a holder — the `statements` fixture — pays for it.
describe('unit · the caller stack rides the event only while capture is held', () => {
  test('off: a subscribed statement carries no stack and builds none', async () => {
    const seen: (string | undefined)[] = [];
    subscribe('db.statement', (event) => void seen.push(event.payload.callerStack));
    const capture = spyOn(Error, 'captureStackTrace');
    try {
      await pgliteClient({ driver: fakeDriver() }).query(sql`select 1`);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
    expect(seen).toEqual([undefined]);
  });

  test('on: the stack is the sender, captured before the driver awaited', async () => {
    const seen: (string | undefined)[] = [];
    subscribe('db.statement', (event) => void seen.push(event.payload.callerStack));
    const release = captureStatementStacks();
    try {
      await pgliteClient({ driver: fakeDriver() }).query(sql`select 1`);
    } finally {
      release();
    }
    expect(seen[0]).toContain('statement-span.test.ts:');
  });
});

describe('unit · no db.statement subscriber builds no event', () => {
  const clockReads = async (send: () => Promise<unknown>): Promise<number> => {
    clock = spyOn(performance, 'now');
    await send();
    const reads = clock.mock.calls.length;
    clock.mockRestore();
    clock = undefined;
    return reads;
  };

  test('the event costs exactly two clock reads, paid only while subscribed', async () => {
    const client = pgliteClient({ driver: fakeDriver() });
    await client.query(sql`select 1`); // the boot is not under test
    const bare = await clockReads(() => client.query(sql`select 1`));
    subscribe('db.statement', () => undefined);
    const observed = await clockReads(() => client.query(sql`select 1`));

    expect(observed - bare).toBe(2);
  });

  test('a silent subscriber changes nothing about what a statement returns', async () => {
    installFakeSql([{ id: 1 }]);
    const bare = await postgresClient({ url: TEST_URL }).query(sql`select ${1}`);

    installFakeSql([{ id: 1 }]);
    subscribe('db.statement', () => undefined);
    const observed = await postgresClient({ url: TEST_URL }).query(sql`select ${1}`);

    expect(observed).toEqual(bare);
  });
});
