import { describe, expect, test } from 'bun:test';
import { diffRows, memoryAuditLog, REDACTED } from './audit';

describe('diffRows', () => {
  test('records only what changed, before and after', () => {
    const diff = diffRows(
      { id: 'p_1', title: 'Draft', views: 3 },
      { id: 'p_1', title: 'Published', views: 3 },
    );
    expect(diff).toEqual([{ field: 'title', before: 'Draft', after: 'Published' }]);
  });

  /**
   * `same()` compared two objects with `JSON.stringify(a) === JSON.stringify(b)`, and
   * `JSON.stringify` THROWS on a bigint. `money()` puts one on the row — `widget-value.ts` states
   * it, Postgres `bigint` minor units — so two distinct `{ minor, currency }` objects (never
   * `===`) reached that branch on EVERY update of a money-bearing row. `crud.ts` calls `diffRows`
   * inside the argument to `ctx.audit.append`, after `repo.update()` has already committed: the
   * write landed, the caller got an uncoded `TypeError`, and the audit log stayed empty.
   *
   * `canonicalJson` is total over every JS value and is already this repo's answer to the same
   * question (`packages/manifest/src/diff-routes.ts`).
   */
  test('a bigint on the row is compared, not thrown on', () => {
    const price = (minor: bigint): Record<string, unknown> => ({
      price: { minor, currency: 'EUR' },
    });
    expect(diffRows(price(1000n), price(1000n))).toEqual([]);
    expect(diffRows(price(1000n), price(2000n))).toEqual([
      {
        field: 'price',
        before: { minor: 1000n, currency: 'EUR' },
        after: { minor: 2000n, currency: 'EUR' },
      },
    ]);
    // A bare bigint field, and a bigint against the number that reads the same: distinct values,
    // so `1000n` and `1000` are a change. Nothing here may throw.
    expect(diffRows({ n: 1000n }, { n: 1000n })).toEqual([]);
    expect(diffRows({ n: 1000n }, { n: 1000 }).length).toBe(1);
  });

  test('added and removed fields both show up', () => {
    expect(diffRows({ a: 1 }, { b: 2 })).toEqual([
      { field: 'a', before: 1, after: undefined },
      { field: 'b', before: undefined, after: 2 },
    ]);
  });

  test('sensitive fields are recorded as changed, without their values', () => {
    const diff = diffRows({ password: 'old' }, { password: 'new' }, { redact: ['password'] });
    expect(diff).toEqual([{ field: 'password', before: REDACTED, after: REDACTED }]);
  });

  test('dates and objects compare by value, not identity', () => {
    expect(diffRows({ at: new Date(0) }, { at: new Date(0) })).toEqual([]);
    expect(diffRows({ meta: { a: 1 } }, { meta: { a: 1 } })).toEqual([]);
    expect(diffRows({ meta: { a: 1 } }, { meta: { a: 2 } }).length).toBe(1);
  });
});

describe('memoryAuditLog', () => {
  test('is append-only and newest-first, with deterministic ids in tests', async () => {
    let tick = 0;
    const log = memoryAuditLog({
      now: (): Date => new Date(1_700_000_000_000 + tick * 1000),
      nextId: (): string => `a_${tick++}`,
    });

    await log.append({
      requestId: 'req_1',
      actor: { id: 'u_1', roles: ['admin'] },
      operation: 'update',
      kind: 'operation',
      entity: 'post',
      entityId: 'p_1',
      permission: 'admin:write',
      outcome: 'allowed',
      reason: 'admin.policy.all-granted',
      diff: [{ field: 'title', before: 'a', after: 'b' }],
    });
    await log.append({
      requestId: 'req_2',
      actor: { id: 'u_2' },
      operation: 'delete',
      kind: 'operation',
      entity: 'post',
      permission: 'admin:destroy',
      outcome: 'denied',
      reason: 'admin.policy.not-granted',
    });

    const entries = log.entries();
    expect(entries.map((entry) => entry.id)).toEqual(['a_1', 'a_0']);
    expect(entries[1]?.diff).toEqual([{ field: 'title', before: 'a', after: 'b' }]);
    expect(entries[1]?.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(entries[0]?.entityId).toBeNull();
    expect(log.entries({ actorId: 'u_2' }).length).toBe(1);
  });

  test('sinks receive every entry', async () => {
    const seen: string[] = [];
    const log = memoryAuditLog({ sinks: [{ write: (entry) => void seen.push(entry.operation) }] });
    await log.append({
      requestId: 'req_1',
      actor: { id: 'u_1' },
      operation: 'create',
      kind: 'operation',
      entity: 'post',
      permission: 'admin:write',
      outcome: 'allowed',
      reason: 'ok',
    });
    expect(seen).toEqual(['create']);
  });
});

/**
 * The ring's own bound, and the one `entries()` takes. `??` guards nullish and `NaN` is not
 * nullish, so `Number(process.env.ADMIN_AUDIT_CAPACITY)` on an unset variable walks past the
 * default and lands on the bound intact — where `log.length > NaN` is FALSE for every length, so
 * the ring stops evicting and the "dev/inspection buffer" grows without limit for the life of the
 * process. `slice(0, NaN)` is the other half and fails the opposite way: an empty audit log,
 * reported as a successful read.
 */
describe('memoryAuditLog · a capacity that is not a number is not a capacity', () => {
  const NOT_A_BOUND = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  const entry = (operation: string) =>
    ({
      requestId: 'req_1',
      actor: { id: 'u_1' },
      operation,
      kind: 'operation',
      entity: 'post',
      permission: 'admin:write',
      outcome: 'allowed',
      reason: 'ok',
    }) as const;

  test('a non-finite capacity is refused, never accepted as an unbounded ring', () => {
    for (const capacity of NOT_A_BOUND) {
      expect(() => memoryAuditLog({ capacity })).toThrow('X_INVARIANT');
    }
  });

  test('a capacity of 0 is refused — a ring that keeps nothing records nothing', () => {
    expect(() => memoryAuditLog({ capacity: 0 })).toThrow('X_INVARIANT');
    expect(memoryAuditLog({ capacity: 1 }).entries()).toEqual([]);
  });

  test('the ring still evicts at the capacity it was given', async () => {
    const log = memoryAuditLog({ capacity: 2 });
    for (const name of ['a', 'b', 'c']) await log.append(entry(name));
    expect(log.entries().map((e) => e.operation)).toEqual(['c', 'b']);
  });

  test('a non-finite entries limit is refused, never read as an empty log', async () => {
    const log = memoryAuditLog();
    await log.append(entry('create'));
    for (const limit of NOT_A_BOUND) {
      expect(() => log.entries({ limit })).toThrow('X_INVARIANT');
    }
    // 0 stays legal: "give me none" is a coherent request, and refusing it would narrow a
    // shipped API for no safety gained.
    expect(log.entries({ limit: 0 })).toEqual([]);
    expect(log.entries({ limit: 1 }).length).toBe(1);
  });
});
