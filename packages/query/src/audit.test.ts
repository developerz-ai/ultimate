/**
 * `query({ audit: true })`, outcome by outcome: one record per call — allowed, denied (before and
 * after the input parse) and failed — in the record shape `@ultimat3/action` writes, held to
 * core's `AUDIT_RECORD_FIELDS` so a field this package forgets is red here. The surfaces, the memo
 * and the sink's own failures are `audit-surfaces.test.ts`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { AuditRecord, AuditSink } from '@ultimat3/core';
import {
  AUDIT_RECORD_FIELDS,
  anonymousActor,
  createContext,
  isUltimateError,
  resetAuditSink,
  setAuditSink,
  userActor,
} from '@ultimat3/core';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { query } from './query';
import { runQuery } from './read';
import { resetRegistry } from './registry';
import { from } from './source';

interface Row {
  readonly id: string;
  readonly title: string;
}

const reader: PolicyActor = {
  ...userActor({ id: 'u1', orgId: 'org-1' }),
  permissions: ['post:read'],
};
const stranger: PolicyActor = { ...userActor({ id: 'u2', orgId: 'org-1' }), permissions: [] };

/** The ring `@ultimat3/action` ships is a sibling's; this is the same contract, unbounded. */
const collecting = (): AuditSink & { readonly records: AuditRecord[] } => {
  const records: AuditRecord[] = [];
  return { records, write: (record) => void records.push(record) };
};

let executed = 0;

const postList = (audit = true) =>
  query({
    input: t.object({ limit: t.number.int().min(1).max(50), open: t.boolean.optional() }),
    // The row-level half reads the PARSED input, so a denial here comes after the parse.
    policy: can('post:read', ({ input }) => (input as { open?: boolean }).open !== false),
    ...(audit ? { audit: true } : {}),
    sql: () =>
      from<Row>('posts', () => {
        executed += 1;
        return [{ id: 'p1', title: 'secret plans' }];
      }).orderBy('id', 'asc'),
  }).named('postList');

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return expect.unreachable('the read was expected to throw');
}

afterEach(() => {
  resetRegistry();
  resetAuditSink();
  executed = 0;
});

describe('unit · an audited read is recorded once per call', () => {
  test('an allowed read: the full record, every field core declares and no other', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const ctx = createContext({ actor: reader });

    await runQuery(postList(), { limit: 5 }, { ctx });

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    if (record === undefined) return expect.unreachable();
    expect(Object.keys(record).sort()).toEqual([...AUDIT_RECORD_FIELDS].sort());
    expect(record).toMatchObject({
      name: 'postList',
      primitive: 'query',
      mutator: false,
      surface: 'server',
      input: { limit: 5 },
      idempotencyKey: null,
      replayed: false,
      outcome: 'allowed',
      failure: null,
    });
    expect(record.ctx.actor.id).toBe('u1');
    expect(record.at).toBeInstanceOf(Date);
  });

  test('the record never carries the rows — who saw what, not a copy of what was seen', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await runQuery(postList(), { limit: 5 }, { ctx: createContext({ actor: reader }) });

    expect(JSON.stringify(sink.records[0]?.input)).not.toContain('secret plans');
    expect(Object.values(sink.records[0] ?? {})).not.toContainEqual([
      { id: 'p1', title: 'secret plans' },
    ]);
  });

  test('a read that declares no audit records nothing — opt-in, never a global switch', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await runQuery(postList(false), { limit: 5 }, { ctx: createContext({ actor: reader }) });

    expect(sink.records).toEqual([]);
  });

  test('no sink installed refuses BEFORE anything is read', async () => {
    const error = await thrown(() =>
      runQuery(postList(), { limit: 5 }, { ctx: createContext({ actor: reader }) }),
    );

    expect(isUltimateError(error) && error.code).toBe('X_QUERY_AUDIT_SINK_MISSING');
    // The fix opens with the call to paste, the registered line verbatim.
    expect(isUltimateError(error) && error.fix).toBe(
      'setAuditSink(sink)   # from @ultimat3/core, at boot before defineApi()',
    );
    expect(executed).toBe(0);
  });

  test('without audit, no sink is needed', async () => {
    const rows = await runQuery(
      postList(false),
      { limit: 5 },
      {
        ctx: createContext({ actor: reader }),
      },
    );
    expect(rows).toHaveLength(1);
  });
});

describe('unit · denied and failed reads are recorded, and the caller still gets its error', () => {
  test('denied before the input parse: the record still names what was attempted', async () => {
    const sink = collecting();
    setAuditSink(sink);

    const error = await thrown(() =>
      runQuery(postList(), { limit: 5 }, { ctx: createContext({ actor: stranger }) }),
    );

    const record = sink.records[0];
    expect(sink.records).toHaveLength(1);
    expect(record?.outcome).toBe('denied');
    expect(record?.failure?.error).toBe(error);
    expect(record?.failure?.code).toBe(
      isUltimateError(error) ? error.code : 'not an UltimateError',
    );
    expect(record?.input).toEqual({ limit: 5 });
    expect(executed).toBe(0);
  });

  test('denied before the parse with an unparseable payload is a record with no input', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await thrown(() =>
      runQuery(postList(), { limit: 'lots' }, { ctx: createContext({ actor: anonymousActor() }) }),
    );

    expect(sink.records[0]?.outcome).toBe('denied');
    expect(sink.records[0]?.input).toBeUndefined();
  });

  test('denied by the row half, after the parse: the parsed input is on the record', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await thrown(() =>
      runQuery(postList(), { limit: 5, open: false }, { ctx: createContext({ actor: reader }) }),
    );

    expect(sink.records[0]?.outcome).toBe('denied');
    expect(sink.records[0]?.input).toEqual({ limit: 5, open: false });
  });

  test('an input that never parsed is FAILED, X_INPUT_INVALID, with no input', async () => {
    const sink = collecting();
    setAuditSink(sink);

    await thrown(() =>
      runQuery(postList(), { limit: 0 }, { ctx: createContext({ actor: reader }) }),
    );

    expect(sink.records[0]).toMatchObject({ outcome: 'failed', input: undefined });
    expect(sink.records[0]?.failure?.code).toBe('X_INPUT_INVALID');
  });

  test('a read that throws while executing is FAILED, and the throwable is the caller’s own', async () => {
    const sink = collecting();
    setAuditSink(sink);
    const boom = new TypeError('the replica is gone');
    const broken = query({
      input: t.object({ limit: t.number }),
      policy: can('post:read'),
      audit: true,
      sql: () =>
        from<Row>('posts', () => {
          throw boom;
        }),
    }).named('brokenList');

    const error = await thrown(() =>
      runQuery(broken, { limit: 1 }, { ctx: createContext({ actor: reader }) }),
    );

    expect(error).toBe(boom);
    expect(sink.records[0]).toMatchObject({ outcome: 'failed', input: { limit: 1 } });
    expect(sink.records[0]?.failure).toEqual({ code: null, error: boom });
  });
});
