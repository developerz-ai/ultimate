/**
 * The durable sink's PROTOCOL, driven through a recording executor rather than a live database —
 * the same shape `idempotency-postgres.test.ts` uses. One statement per record, append-only, and
 * an allow-list of framework facts: a `Ctx` carries the app's whole service bag on the object
 * itself (`createContext` spreads services onto it), so anything but an allow-list writes an
 * app's repositories, clients and closures into an audit table.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, REDACTED, secret, userActor } from '@ultimat3/core';
import type { AuditRecord } from './audit';
import { postgresAuditSink, SQL_AUDIT_INSERT, SQL_AUDIT_TABLE } from './audit-postgres';
import type { PgExecutor } from './idempotency-postgres';

interface Call {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function executor(): { readonly exec: PgExecutor; readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  const exec: PgExecutor = {
    query<R>(sql: string, params: readonly unknown[]): Promise<readonly R[]> {
      calls.push({ sql, params });
      return Promise.resolve([] as unknown as readonly R[]);
    },
  };
  return { exec, calls };
}

const AT = new Date(1_700_000_000_000);

const ctxFor = (over: Parameters<typeof createContext>[0] = {}) =>
  createContext({
    requestId: 'req-1',
    traceId: '0af7651916cd43dd8448eb211c80319c',
    locale: 'es-ES',
    tz: 'Europe/Madrid',
    buildId: 'build-7',
    actor: userActor({ id: 'u1', orgId: 'org-1' }),
    ...over,
  });

const recordFor = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  at: AT,
  action: 'publishPost',
  mutator: true,
  surface: 'http',
  ctx: ctxFor(),
  input: { postId: 'p1' },
  idempotencyKey: null,
  replayed: false,
  outcome: 'allowed',
  failure: null,
  ...over,
});

/** The insert's params, by the column order `SQL_AUDIT_INSERT` declares. */
const paramsOf = (calls: readonly Call[]): readonly unknown[] => calls[0]?.params ?? [];

describe('the postgres audit sink writes one append-only row', () => {
  test('one insert per record, and it is the declared statement', async () => {
    const { exec, calls } = executor();
    await postgresAuditSink({ executor: exec }).write(recordFor());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(SQL_AUDIT_INSERT);
  });

  test('the framework facts reach the row', async () => {
    const { exec, calls } = executor();
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ idempotencyKey: 'publishPost:k1', replayed: true }),
    );

    const params = paramsOf(calls);
    expect(params).toContain('publishPost');
    expect(params).toContain('http');
    expect(params).toContain('allowed');
    expect(params).toContain('req-1');
    expect(params).toContain('0af7651916cd43dd8448eb211c80319c');
    expect(params).toContain('es-ES');
    expect(params).toContain('Europe/Madrid');
    expect(params).toContain('build-7');
    expect(params).toContain('u1');
    expect(params).toContain('org-1');
    expect(params).toContain('publishPost:k1');
    expect(params[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(params).toContain(AT.toISOString());
  });

  test('a failure contributes its CODE and never the thrown value', async () => {
    const { exec, calls } = executor();
    const thrown = new TypeError('a stack worth reading, and not worth storing');
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ outcome: 'denied', failure: { code: 'X_FORBIDDEN', error: thrown } }),
    );

    const params = paramsOf(calls);
    expect(params).toContain('denied');
    expect(params).toContain('X_FORBIDDEN');
    expect(params).not.toContain(thrown);
    expect(JSON.stringify(params)).not.toContain('a stack worth reading');
  });

  test('a credential in the input is redacted before it is a row', async () => {
    const { exec, calls } = executor();
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ input: { email: 'ada@example.test', password: 'hunter2', apiKey: secret('k') } }),
    );

    const body = JSON.stringify(paramsOf(calls));
    expect(body).not.toContain('hunter2');
    expect(body).toContain(REDACTED);
    expect(body).toContain('ada@example.test');
  });

  /**
   * The failure this allow-list exists for. `createContext` spreads every installed service ONTO
   * the context object, so a projection that walked the ctx would put an app's repositories,
   * database clients and closures into an audit table — and on an HTTP surface the object is a
   * `RequestContext`, which carries the request's own `Authorization` and `Cookie` headers.
   */
  test('nothing from the service bag or an app’s own ctx fields reaches a param', async () => {
    const { exec, calls } = executor();
    // Spread rather than mutated: `createContext` freezes what it returns, and an HTTP surface
    // hands this seam a `RequestContext` whose `requestHeaders` this shape stands in for.
    const ctx = {
      ...ctxFor({ services: { billing: { apiToken: 'sk_live_do_not_store' } } }),
      requestHeaders: new Headers({ authorization: 'Bearer do_not_store' }),
    };
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ ctx: ctx as unknown as AuditRecord['ctx'] }),
    );

    const body = JSON.stringify(paramsOf(calls));
    expect(body).not.toContain('sk_live_do_not_store');
    expect(body).not.toContain('do_not_store');
    expect(body).not.toContain('billing');
  });

  test('an input that never parsed is a null column, not the string "undefined"', async () => {
    const { exec, calls } = executor();
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ input: undefined, outcome: 'failed', failure: { code: null, error: null } }),
    );

    expect(paramsOf(calls)).toContain(null);
    expect(JSON.stringify(paramsOf(calls))).not.toContain('"undefined"');
  });

  test('impersonation is recorded as two facts and interpreted as neither', async () => {
    const { exec, calls } = executor();
    const impersonated = {
      ...userActor({ id: 'u1', orgId: 'org-1' }),
      onBehalfOf: { actorId: 'admin-9', actorKind: 'user' as const },
    };
    await postgresAuditSink({ executor: exec }).write(
      recordFor({ ctx: ctxFor({ actor: impersonated }) }),
    );

    const params = paramsOf(calls);
    expect(params).toContain('u1');
    expect(params).toContain('admin-9');
  });
});

describe('the table is append-only, and the DDL follows the house rule', () => {
  test('the sink issues no update and no delete, ever', async () => {
    const { exec, calls } = executor();
    const sink = postgresAuditSink({ executor: exec });
    for (let n = 0; n < 5; n += 1) await sink.write(recordFor());

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.sql.toLowerCase()).not.toMatch(/\b(update|delete|truncate)\b/);
    }
  });

  test('the DDL creates if not exists and edits nothing that already exists', () => {
    expect(SQL_AUDIT_TABLE).toContain('create table if not exists x_audit');
    expect(SQL_AUDIT_TABLE.toLowerCase()).not.toMatch(/\b(drop|truncate)\b/);
    for (const statement of SQL_AUDIT_TABLE.split(';')) {
      if (statement.trim().length === 0) continue;
      expect(statement.trim().toLowerCase()).toMatch(/^create (table|index) if not exists/);
    }
  });
});

/**
 * `at` is `ctx.now()` and a `Clock` is injectable, so an app can hand this seam an Invalid Date —
 * and `Date.prototype.toISOString` throws a `RangeError` on one. A sink that raises fails an
 * invocation whose handler has already committed, which is a worse outcome than a row that cannot
 * say when: the database's own `recorded_at` still stamps it.
 */
describe('nothing about a record can make the sink itself throw', () => {
  test('an Invalid Date is a null column, never a RangeError out of write()', async () => {
    const { exec, calls } = executor();
    await expect(
      postgresAuditSink({ executor: exec }).write(recordFor({ at: new Date(Number.NaN) })),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(paramsOf(calls)[1]).toBeNull();
  });
});
