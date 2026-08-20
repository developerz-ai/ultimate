import { describe, expect, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import { formatLsn } from './changefeed';
import type { Row } from './json';
import {
  applyToWindow,
  bridgeChange,
  canAffect,
  type IncrementalMatcher,
  narrowRow,
  normalizePatch,
  patchFromChange,
  projectionOf,
  type SubscriptionShape,
  toBridgeResult,
} from './matcher-bridge';

const before: Row = { id: 'p1', orgId: 'o1', title: 'draft', likes: 1, internalNote: 'x' };
const after: Row = { ...before, likes: 2 };

const update: ChangeEvent = {
  entity: 'posts',
  op: 'update',
  before,
  after,
  lsn: formatLsn(9),
  txid: '9',
  orgId: 'o1',
  at: 1_000,
};

const shape: SubscriptionShape = {
  qid: 'liveFeed:abcd1234',
  entities: ['posts'],
  orgId: 'o1',
  columns: ['title', 'likes'],
};

const always: IncrementalMatcher = {
  entities: ['posts'],
  match: (change) => {
    const patch = patchFromChange(change);
    return { patches: patch ? [patch] : [], refill: false };
  },
};

const window: readonly Row[] = [before];

describe('matcher bridge', () => {
  test('a change produces a minimal patch — changed columns plus the id', () => {
    const result = bridgeChange(shape, always, update, window);
    expect(result?.patches).toEqual([
      { op: 'update', id: 'p1', row: { id: 'p1', likes: 2 }, lsn: formatLsn(9) },
    ]);
  });

  test('an insert carries the whole row; a delete carries none of it', () => {
    const inserted = patchFromChange({ ...update, op: 'insert', before: null });
    expect(inserted?.row).toEqual(after);
    const deleted = patchFromChange({ ...update, op: 'delete', after: null });
    expect(deleted).toEqual({ op: 'delete', id: 'p1', row: null, lsn: formatLsn(9) });
  });

  test('the pre-filter skips subscriptions the change cannot touch', () => {
    expect(canAffect(shape, { ...update, entity: 'comments' })).toBe(false);
    expect(canAffect(shape, { ...update, orgId: 'o2' })).toBe(false);
    // Touches only a column this query never reads.
    const noise: ChangeEvent = { ...update, before, after: { ...before, internalNote: 'y' } };
    expect(canAffect(shape, noise)).toBe(false);
    expect(bridgeChange(shape, always, noise, window)).toBeNull();
  });

  test('a skipped subscription never reaches the matcher', () => {
    let calls = 0;
    const counting: IncrementalMatcher = {
      entities: ['posts'],
      match: (change) => {
        calls += 1;
        return always.match(change, window);
      },
    };
    bridgeChange(shape, counting, { ...update, entity: 'comments' }, window);
    expect(calls).toBe(0);
    bridgeChange(shape, counting, update, window);
    expect(calls).toBe(1);
  });

  test("query's positional patches map onto the wire shape", () => {
    const result = toBridgeResult(
      [
        { kind: 'add', position: 0, row: after },
        { kind: 'remove', position: 4, id: 'p9' },
        { kind: 'refill', from: 3 },
      ],
      update,
    );
    expect(result.refill).toBe(true);
    expect(result.patches).toEqual([
      { op: 'insert', id: 'p1', row: after, lsn: formatLsn(9), index: 0 },
      { op: 'delete', id: 'p9', row: null, lsn: formatLsn(9), index: 4 },
    ]);
  });

  test('the shared window tracks inserts, updates, and deletes in order', () => {
    const rows = applyToWindow(window, [
      { op: 'insert', id: 'p2', row: { id: 'p2', likes: 0 }, lsn: formatLsn(9), index: 0 },
      { op: 'update', id: 'p1', row: { id: 'p1', likes: 2 }, lsn: formatLsn(9) },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['p2', 'p1']);
    expect(rows[1]?.['likes']).toBe(2);
    expect(
      applyToWindow(rows, [{ op: 'delete', id: 'p2', row: null, lsn: formatLsn(9) }]),
    ).toHaveLength(1);
  });

  test('a foreign matcher answer is normalized rather than trusted', () => {
    expect(normalizePatch(true, update)).toEqual(patchFromChange(update));
    expect(normalizePatch(null, update)).toBeNull();
    expect(normalizePatch({ op: 'insert', id: 'p1', row: { id: 'p1' }, index: 3 }, update)).toEqual(
      {
        op: 'insert',
        id: 'p1',
        row: { id: 'p1' },
        lsn: formatLsn(9),
        index: 3,
      },
    );
  });
});

/**
 * #230's leak half, and it is independent of the ordering key. A `ChangeEvent` carries the whole
 * TABLE row — that is what logical replication emits and what `setRowObserver` emits — while a live
 * query's result set is whatever its `sql` returned. Every patch used to forward the change row
 * unnarrowed, so a projection's dropped columns went out on the socket: `examples/dummy`'s feed
 * projects ten columns and one publish delivered `body` to every subscriber.
 */
describe('a patch carries the result set\u2019s columns, never the table\u2019s', () => {
  const projection = new Set(['id', 'orgId', 'title', 'likes']);

  const changeOf = (op: 'insert' | 'update', row: Row, previous?: Row): ChangeEvent => ({
    entity: 'posts',
    op,
    before: previous ?? null,
    after: row,
    lsn: formatLsn(11),
    txid: '11',
    orgId: 'o1',
    at: 1_000,
  });

  test('narrowRow keeps the projection and drops the rest', () => {
    expect(narrowRow(after, projection)).toEqual({
      id: 'p1',
      orgId: 'o1',
      title: 'draft',
      likes: 2,
    });
  });

  // `id` is the row's identity on the wire — `applyToWindow` and every client store key by it — so
  // it survives a projection that somehow did not name it.
  test('id survives whatever the projection says', () => {
    expect(narrowRow(after, new Set(['title']))).toEqual({ id: 'p1', title: 'draft' });
  });

  // Nothing read yet is not the same as "the result set has no columns". Inventing a shape there
  // would drop columns a caller is owed.
  test('an unknown projection narrows nothing', () => {
    expect(narrowRow(after, undefined)).toEqual(after);
  });

  test('projectionOf reads the shape off the window, and answers nothing for an empty one', () => {
    expect(projectionOf([{ id: 'p1', title: 'hi' } as Row])).toEqual(new Set(['id', 'title']));
    expect(projectionOf([])).toBeUndefined();
  });

  test('an insert patch is narrowed', () => {
    const change = changeOf('insert', after);
    const result = toBridgeResult([{ kind: 'add', position: 0, row: after }], change, projection);
    expect(result.patches[0]?.row).toEqual({ id: 'p1', orgId: 'o1', title: 'draft', likes: 2 });
  });

  test('an update patch is narrowed after the changed columns are computed', () => {
    const changed: Row = { ...before, likes: 2, internalNote: 'y' };
    const change = changeOf('update', changed, before);
    const result = toBridgeResult(
      [{ kind: 'update', position: 0, row: changed }],
      change,
      projection,
    );
    // `internalNote` changed and is dropped; `likes` changed and is kept.
    expect(result.patches[0]?.row).toEqual({ id: 'p1', likes: 2 });
  });
});
