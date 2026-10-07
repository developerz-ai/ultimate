// The hop nothing covered: a row that came out of `PgOutputDecoder`, handed to the matcher that
// patches a live window. `pg-replication.test.ts` exercises the decoder and stops at
// `ChangeEvent`; `matcher-bridge.test.ts` starts from hand-written rows. The defect lived exactly
// in between — the decoder's values were postgres' own text and the window's were the repository's
// objects, so `compareValues(new Date(…), '2026-08-09 11:00:00+00')` fell to `String(left) <
// String(right)` and every edit to any column re-sorted the whole feed.

import { expect, test } from 'bun:test';
import { arrayOf, entity, entityForTable, text, timestamp } from '@ultimat3/entity';
import { match, type QueryShape } from '@ultimat3/query';
import { memoryAdvisoryLock } from './advisory-lock';
import { memoryChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import type { Row } from './json';
import { entityRow } from './pg-entity-row';
import { insert, POSTS_OID, relation, update } from './pg-replication-fixture';
import { PgOutputDecoder } from './pgoutput';
import { changeFeedReplicator } from './replicator';
import { parseEnvelope } from './replicator-envelope';

const TIMESTAMPTZ = 1184;
const TEXT_ARRAY = 1009;

const COLUMNS = [
  { name: 'id', key: true },
  { name: 'title' },
  { name: 'tags', type: TEXT_ARRAY },
  { name: 'created_at', type: TIMESTAMPTZ },
];

/** The declared order of `examples/dummy`'s feed: newest first, id as the total-order tiebreak. */
const FEED: QueryShape = {
  entity: 'posts',
  filters: [],
  orderBy: [
    { column: 'createdAt', direction: 'desc' },
    { column: 'id', direction: 'asc' },
  ],
  limit: 10,
  unsupported: [],
};

/**
 * The shared window as a repository fills it: `timestamp()` reads back as a `Date` and
 * `arrayOf(text())` as a JS array, because those are what `@ultimat3/entity`'s column parsers
 * produce. Nothing here is hand-shaped to suit the decoder — that is the whole point.
 */
const WINDOW: readonly Row[] = [
  windowRow('a', 'A', ['x'], '2026-08-09T12:00:00.000Z'),
  windowRow('b', 'B', ['y'], '2026-08-09T11:00:00.000Z'),
];

/**
 * `Row` is `JsonObject & { id }` and a `Date` is not a `JsonValue` — which is exactly the tension
 * this file is about: the shared window HOLDS repository objects and `JSON.stringify` is what makes
 * them JSON on the wire. `rowsOf` in `live-definition.ts` crosses the same line through `isRow`.
 */
function windowRow(id: string, title: string, tags: string[], at: string): Row {
  const row: Record<string, unknown> = { id, title, tags, createdAt: new Date(at) };
  return row as unknown as Row;
}

/** The entity the replicated rows decode through, as a repository read's rows are. */
function ensureFeedPosts(): void {
  if (entityForTable('feed_posts') !== undefined) return;
  entity('feed_posts', {
    columns: {
      id: text().primaryKey(),
      title: text(),
      tags: arrayOf(text()),
      createdAt: timestamp(),
    },
  });
}

/** A decoder that has already seen the Relation message, the way a live connection has. */
function seeded(): PgOutputDecoder {
  ensureFeedPosts();
  const decoder = new PgOutputDecoder();
  decoder.decode(relation(POSTS_OID, 'feed_posts', COLUMNS));
  return decoder;
}

test('an edit to one column patches that row in place, never re-sorting the feed', () => {
  const decoder = seeded();
  const message = decoder.decode(
    update(
      POSTS_OID,
      ['b', 'B', '{y}', '2026-08-09 11:00:00+00'],
      ['b', 'B (edited)', '{y}', '2026-08-09 11:00:00+00'],
    ),
  );
  expect(message.kind).toBe('update');
  if (message.kind !== 'update') return;

  const patches = match<Row>('feed', FEED, WINDOW, {
    entity: 'posts',
    op: 'update',
    row: entityRow(message.relation, message.after, 'after') as Row,
    ...(message.before === null
      ? {}
      : { before: entityRow(message.relation, message.before, 'before') as Row }),
  });

  // The row did not move: only `title` changed and `createdAt` is untouched. A `remove` + `add`
  // here is the feed jumping to the top for every subscriber, which is what shipped.
  expect(patches.map((patch) => patch.kind)).toEqual(['update']);
  expect(patches[0]).toMatchObject({ kind: 'update', position: 1 });
});

test('a new row lands at the position its instant actually orders it to', () => {
  const decoder = seeded();
  const message = decoder.decode(insert(POSTS_OID, ['c', 'C', '{z}', '2026-08-09 11:30:00+00']));
  expect(message.kind).toBe('insert');
  if (message.kind !== 'insert') return;

  const patches = match<Row>('feed', FEED, WINDOW, {
    entity: 'posts',
    op: 'insert',
    row: entityRow(message.relation, message.after, 'after') as Row,
  });

  // 11:30 sits between 12:00 and 11:00 under `createdAt desc`. Compared as text against a `Date`'s
  // epoch number, every WAL row sorted to one end regardless of its instant.
  expect(patches.map((patch) => patch.kind)).toEqual(['add']);
  expect(patches[0]).toMatchObject({ kind: 'add', position: 1 });
});

test('the row the matcher is handed carries an array, not the postgres array literal', () => {
  const decoder = seeded();
  const message = decoder.decode(insert(POSTS_OID, ['c', 'C', '{z,w}', '2026-08-09 11:30:00+00']));
  if (message.kind !== 'insert') return expect.unreachable();

  const row = entityRow(message.relation, message.after, 'after');
  // `post.tags.map(...)` in a component is the caller. A string here throws there.
  expect(row['tags']).toEqual(['z', 'w']);
  expect(row['createdAt']).toBeInstanceOf(Date);
});

test('a column named __proto__ is a column, never the row prototype', () => {
  // `column.name` is off the wire, so the assignment that builds a tuple can be the one that sets
  // `Object.prototype` for every object this process makes afterwards.
  const decoder = new PgOutputDecoder();
  decoder.decode(relation(POSTS_OID, 'posts', [{ name: 'id', key: true }, { name: '__proto__' }]));
  const message = decoder.decode(insert(POSTS_OID, ['a', 'polluted']));
  if (message.kind !== 'insert') return expect.unreachable();

  expect(Object.hasOwn(message.after, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(message.after)).toBeNull();
  // The pollution, asked without naming the deprecated accessor: an ordinary object built after
  // the decode still has `Object.prototype` behind it and inherits nothing the tuple carried.
  expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});

// The same edit, across the bus. Every case above hands the decoded row to the matcher directly —
// which is what `live-replicator.ts` does and why every in-process suite was green. A deployment
// has a transport in between, the transport carries text, and the row came out the other side
// with its `Date` an ISO string: `compareRows` then ordered a string against the window's `Date`.
test('an edit keeps its place after the row crosses the replicator bus as text', async () => {
  const decoder = seeded();
  const message = decoder.decode(
    update(
      POSTS_OID,
      ['b', 'B', '{y}', '2026-08-09 11:00:00+00'],
      ['b', 'B (edited)', '{y}', '2026-08-09 11:00:00+00'],
    ),
  );
  if (message.kind !== 'update' || message.before === null) return expect.unreachable();

  const wire: string[] = [];
  const transport = new InProcessTransport();
  await transport.subscribe('x.change.>', (payload) => void wire.push(payload));
  const feed = memoryChangeFeed();
  const replicator = changeFeedReplicator({
    feed,
    transport,
    lock: memoryAdvisoryLock('x:replicator:parity'),
  });
  await replicator.start();
  await feed.push('feed_posts', 'update', {
    before: entityRow(message.relation, message.before, 'before') as Row,
    after: entityRow(message.relation, message.after, 'after') as Row,
  });
  await replicator.stop();

  const change = parseEnvelope(wire[0] ?? '')?.change;
  if (change === undefined || change.after === null || change.before === null) {
    return expect.unreachable();
  }
  // A `Date` again, on both images — not the ISO text the wire carried it as.
  expect((change.after as Record<string, unknown>)['createdAt']).toBeInstanceOf(Date);
  expect((change.before as Record<string, unknown>)['createdAt']).toBeInstanceOf(Date);

  const patches = match<Row>('feed', FEED, WINDOW, {
    entity: 'posts',
    op: 'update',
    row: change.after,
    before: change.before,
  });
  expect(patches.map((patch) => patch.kind)).toEqual(['update']);
  expect(patches[0]).toMatchObject({ kind: 'update', position: 1 });
});
