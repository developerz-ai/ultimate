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
