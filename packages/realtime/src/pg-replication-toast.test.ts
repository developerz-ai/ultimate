// An UPDATE that leaves a large column untouched. Postgres logs no bytes for an unchanged
// out-of-line (TOAST) value, so the new tuple arrives without it — and the change used to be
// published as though that tuple were the whole row. Split from `pg-replication.test.ts` at the
// file ceiling.

import { expect, test } from 'bun:test';
import {
  begin,
  commit,
  POST_COLUMNS,
  POSTS_OID,
  relation,
  start,
  UNCHANGED_TOAST,
  update,
  xlog,
} from './pg-replication-fixture';
import { PgOutputDecoder } from './pgoutput';

/** Stands in for the out-of-line value: what matters to the decoder is the `'u'`, never the size. */
const BIG = 'a body nobody edited';

test('the decoder names the columns an update left out, apart from the ones it nulled', () => {
  const decoder = new PgOutputDecoder();
  decoder.decode(relation(POSTS_OID, 'posts', POST_COLUMNS));
  const message = decoder.decode(
    update(POSTS_OID, null, ['p1', UNCHANGED_TOAST, 'o1', null, null, null]),
  );
  if (message.kind !== 'update') return expect.unreachable();

  expect(message.unchanged).toEqual(['title']);
  expect(Object.hasOwn(message.after, 'title')).toBe(false);
  // Nulled is a value; left out is not.
  expect(message.after['price_minor']).toBeNull();
});

test('under REPLICA IDENTITY FULL the untouched column is carried over from the old row', async () => {
  const { server, events, settled, feed } = await start();
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'f')));
  server.push(
    xlog(
      update(
        POSTS_OID,
        ['p1', BIG, 'o1', null, null, null],
        ['p1', UNCHANGED_TOAST, 'o2', null, null, null],
      ),
    ),
  );
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await settled(1);
  await feed.stop();

  expect(events).toHaveLength(1);
  expect(events[0]?.after).toMatchObject({ id: 'p1', title: BIG, orgId: 'o2' });
  // The whole row, so nothing downstream is told to distrust it.
  expect(Object.hasOwn(events[0] ?? {}, 'omitted')).toBe(false);
});

test('under the default identity the change names the property it could not carry', async () => {
  const { server, events, settled, feed } = await start();
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
  // No old tuple at all: the key did not change, so the default identity sends none.
  server.push(xlog(update(POSTS_OID, null, ['p1', UNCHANGED_TOAST, 'o2', null, null, null])));
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await settled(1);
  await feed.stop();

  expect(events).toHaveLength(1);
  expect(events[0]?.omitted).toEqual(['title']);
  expect(Object.hasOwn(events[0]?.after ?? {}, 'title')).toBe(false);
  expect(events[0]?.after).toMatchObject({ id: 'p1', orgId: 'o2', price: null });
});

test('a key-only old tuple is never read as the untouched value', async () => {
  // `K`/`O` under a non-FULL identity carries NULL for every non-key column — a placeholder. Copied
  // across, it would publish `title: null` for a row whose title was never touched.
  const { server, events, settled, feed } = await start();
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
  server.push(
    xlog(
      update(
        POSTS_OID,
        ['p0', null, null, null, null, null],
        ['p1', UNCHANGED_TOAST, 'o2', null, null, null],
      ),
    ),
  );
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await settled(1);
  await feed.stop();

  expect(events[0]?.omitted).toEqual(['title']);
  expect(Object.hasOwn(events[0]?.after ?? {}, 'title')).toBe(false);
});

test('an update that carried every column says nothing about omissions', async () => {
  const { server, events, settled, feed } = await start();
  server.push(xlog(begin(0x100n, 0n, 7)));
  server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS, 'd')));
  server.push(xlog(update(POSTS_OID, null, ['p1', 'short', 'o2', null, null, null])));
  server.push(xlog(commit(0x100n, 0x108n, 0n)));
  await settled(1);
  await feed.stop();

  expect(Object.hasOwn(events[0] ?? {}, 'omitted')).toBe(false);
});
