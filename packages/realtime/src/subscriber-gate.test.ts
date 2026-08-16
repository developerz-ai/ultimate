// The fence between a decision and a failure. A gate that denies drops the row and counts it; a
// gate that raises anything else must not be readable as "denied" — it counts separately, reports
// separately, and the throw reaches the caller.

import { describe, expect, test } from 'bun:test';
import { type Actor, userActor } from '@ultimat3/core';
import type { JsonValue, Row, RowPatch } from './json';
import type { LiveQueryDefinition } from './live-contract';
import {
  type GateFailed,
  type GateTarget,
  type RowDenied,
  type Subscriber,
  SubscriberGate,
} from './subscriber-gate';

const alice: Actor = userActor({ id: 'alice', orgId: 'o1' });
const who: Subscriber = { sid: 's1', actor: alice };
const rows: readonly Row[] = [
  { id: 'p1', ownerId: 'alice', title: 'mine' },
  { id: 'p2', ownerId: 'bob', title: 'theirs' },
];

/** A denial as it arrives from a real policy: an `UltimateError`-shaped throw carrying the code. */
class Denied extends Error {
  readonly code = 'X_FORBIDDEN';
}

/** A pool that ran out of connections while a rule tried to load the row it decides about. */
class PoolTimeout extends Error {
  readonly code = 'X_DB_TIMEOUT';
}

function targetFor(visible: LiveQueryDefinition['visible'], window = rows): GateTarget {
  const definition = {
    name: 'liveFeed',
    entities: ['posts'],
    snapshot: async () => ({ rows: window, lsn: '1' }),
    visible,
    matcher: () => ({ entities: ['posts'], match: () => ({ patches: [], refill: false }) }),
  } satisfies LiveQueryDefinition;
  return { qid: 'liveFeed:1', input: {} as JsonValue, definition, rows: window };
}

const patchOf = (id: string, row: Row | null = { id, title: 'edited' }): RowPatch => ({
  op: row === null ? 'delete' : 'update',
  id,
  row,
  lsn: '2',
});

describe('SubscriberGate — a denial', () => {
  test('drops the row, counts it once, and reports it', async () => {
    const denials: RowDenied[] = [];
    const gate = new SubscriberGate({ onRowDenied: (event) => denials.push(event) });
    const target = targetFor(({ row }) => row['ownerId'] === 'alice');

    const kept = await gate.filterRows(target, who, rows);

    expect(kept.map((row) => row.id)).toEqual(['p1']);
    expect(gate.rowsDenied).toBe(1);
    expect(gate.gateFailures).toBe(0);
    expect(denials).toEqual([{ qid: 'liveFeed:1', sid: 's1', actorId: 'alice', rowId: 'p2' }]);
  });

  test('a predicate that throws a denial is a decision, not a failure', async () => {
    const gate = new SubscriberGate({});
    const target = targetFor(({ row }) => {
      if (row['ownerId'] !== 'alice') throw new Denied('row:read denied');
      return true;
    });

    await expect(gate.filterRows(target, who, rows)).resolves.toHaveLength(1);
    expect(gate.rowsDenied).toBe(1);
    expect(gate.gateFailures).toBe(0);
  });
});

describe('SubscriberGate — a failure', () => {
  test('raises instead of answering "not visible", and never counts a denial', async () => {
    const denials: RowDenied[] = [];
    const failures: GateFailed[] = [];
    const gate = new SubscriberGate({
      onRowDenied: (event) => denials.push(event),
      onGateFailed: (event) => failures.push(event),
    });
    const target = targetFor(() => {
      throw new PoolTimeout('connection pool exhausted');
    });

    await expect(gate.filterRows(target, who, rows)).rejects.toThrow('connection pool exhausted');

    expect(denials).toEqual([]);
    expect(gate.rowsDenied).toBe(0);
    expect(gate.gateFailures).toBe(1);
    expect(failures[0]?.stage).toBe('snapshot');
    expect(failures[0]?.rowId).toBe('p1');
    expect(failures[0]?.error).toBeInstanceOf(PoolTimeout);
  });

  test('never hands back the rows it managed to admit before it broke', async () => {
    const gate = new SubscriberGate({});
    // p1 decides, p2 cannot. A short snapshot is indistinguishable from a correct one.
    const target = targetFor(({ row }) => {
      if (row.id === 'p2') throw new PoolTimeout('connection pool exhausted');
      return true;
    });

    await expect(gate.filterRows(target, who, rows)).rejects.toThrow(PoolTimeout);
  });

  test('a failing patch gate reports `patch`, and rides out of filterPatches', async () => {
    const failures: GateFailed[] = [];
    const gate = new SubscriberGate({ onGateFailed: (event) => failures.push(event) });
    const target = targetFor(() => {
      throw new PoolTimeout('connection pool exhausted');
    });

    await expect(gate.filterPatches(target, who, [patchOf('p1')], new Set())).rejects.toThrow(
      PoolTimeout,
    );
    expect(failures[0]?.stage).toBe('patch');
    expect(failures[0]?.rowId).toBe('p1');
  });

  test('failedAuthorize carries no row id — it decides about a subscription', () => {
    const failures: GateFailed[] = [];
    const gate = new SubscriberGate({ onGateFailed: (event) => failures.push(event) });

    gate.failedAuthorize('liveFeed:1', who, new PoolTimeout('connection pool exhausted'));

    expect(gate.gateFailures).toBe(1);
    expect(gate.rowsDenied).toBe(0);
    expect(failures[0]?.stage).toBe('authorize');
    expect(failures[0]).not.toHaveProperty('rowId');
  });
});

describe('SubscriberGate — patches', () => {
  test('a delete needs no decision: the row is already gone', async () => {
    const gate = new SubscriberGate({});
    const target = targetFor(() => {
      throw new PoolTimeout('never reached');
    });

    const out = await gate.patch(target, who, patchOf('p1', null), true);

    expect(out?.op).toBe('delete');
    expect(gate.gateFailures).toBe(0);
  });

  test('the rule sees the whole window row, never the partial patch', async () => {
    const seen: Row[] = [];
    const gate = new SubscriberGate({});
    const target = targetFor(({ row }) => {
      seen.push(row);
      return true;
    });

    await gate.patch(
      target,
      who,
      { op: 'update', id: 'p2', row: { title: 'edited' }, lsn: '2' },
      false,
    );

    expect(seen[0]).toEqual({ id: 'p2', ownerId: 'bob', title: 'edited' });
  });

  test('a held row that leaves the policy becomes a delete; an unheld one is dropped', async () => {
    const gate = new SubscriberGate({});
    const target = targetFor(() => false);

    await expect(gate.patch(target, who, patchOf('p2'), true)).resolves.toMatchObject({
      op: 'delete',
      id: 'p2',
    });
    await expect(gate.patch(target, who, patchOf('p2'), false)).resolves.toBeNull();
    expect(gate.rowsDenied).toBe(2);
  });
});

describe('SubscriberGate — a patch whose row the window does not hold', () => {
  /** The columns an update patch carries: the change and the id, never the whole row. */
  const partial: RowPatch = { op: 'update', id: 'p9', row: { title: 'edited' }, lsn: '2' };

  test('never reaches the rule, so nothing decides on the columns nobody sent', async () => {
    const seen: Row[] = [];
    const gate = new SubscriberGate({});
    // The shape that leaks rather than fail-closed: `undefined !== true` reads as "public", so the
    // merged partial row would have been authorized on a column the patch never carried.
    const target = targetFor(({ row }) => {
      seen.push(row);
      return row['private'] !== true;
    });

    await expect(gate.patch(target, who, partial, false)).resolves.toBeNull();

    expect(seen).toEqual([]);
  });

  test('a subscriber holding it is told the row is gone, not left rendering it', async () => {
    const gate = new SubscriberGate({});
    const target = targetFor(() => true);

    await expect(gate.patch(target, who, partial, true)).resolves.toEqual({
      op: 'delete',
      id: 'p9',
      row: null,
      lsn: '2',
    });
  });

  test('is neither a denial nor a gate failure — the window simply does not hold the row', async () => {
    const denials: RowDenied[] = [];
    const failures: GateFailed[] = [];
    const gate = new SubscriberGate({
      onRowDenied: (event) => denials.push(event),
      onGateFailed: (event) => failures.push(event),
    });

    await gate.filterPatches(
      targetFor(() => true),
      who,
      [partial],
      new Set(['p9']),
    );

    expect(denials).toEqual([]);
    expect(failures).toEqual([]);
    expect(gate.rowsDenied).toBe(0);
    expect(gate.gateFailures).toBe(0);
  });

  test('an insert carrying the whole row is decided on, never withheld', async () => {
    const gate = new SubscriberGate({});
    const target = targetFor(({ row }) => row['ownerId'] === 'alice');
    const insert: RowPatch = {
      op: 'insert',
      id: 'p3',
      row: { id: 'p3', ownerId: 'alice', title: 'new' },
      lsn: '2',
    };

    // The window is read at gate time, so a row `applyToWindow` has already landed is a whole one.
    const target3 = { ...target, rows: [...rows, insert.row as Row] };
    await expect(gate.patch(target3, who, insert, false)).resolves.toBe(insert);
  });
});
