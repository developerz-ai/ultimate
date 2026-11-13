// unit — `markRead`'s statement count. A screenful of 50 ids was one update per row (51
// statements); it is one chain `updateAll` and one read back, whatever the batch.

import { expect, test } from 'bun:test';
import { db } from '@social-media-clone/db';
import { testStatements } from '@ultimat3/testing';
import { MARK_READ_MAX, markRead } from './repo';

const OWNER = '00000000-0000-4000-8000-0000000000d1';
const ACTOR = '00000000-0000-4000-8000-0000000000d2';
const EARLIER = new Date('2026-08-11T09:00:00Z');
const NOW = new Date('2026-08-11T12:00:00Z');

test('marking 50 notifications read is two statements, and an already-read row keeps its stamp', async () => {
  const rows = await db.notifications.insertAll(
    Array.from({ length: MARK_READ_MAX }, () => ({
      userId: OWNER,
      kind: 'message' as const,
      actorId: ACTOR,
    })),
  );
  const [already] = rows;
  if (already === undefined) expect.unreachable('insertAll returned no rows');
  await db.notifications.update(already.id, { readAt: EARLIER });

  let sent = 0;
  let marked: Awaited<ReturnType<typeof markRead>> = [];
  {
    // Disposal throws `X_N_PLUS_ONE_WRITE` for a per-row update — the loop this test pins.
    using statements = await testStatements();
    marked = await markRead(
      OWNER,
      rows.map((row) => row.id),
      NOW,
    );
    sent = statements.count();
  }

  expect(sent).toBeLessThanOrEqual(2);
  expect(marked).toHaveLength(MARK_READ_MAX);
  const stamps = new Map(marked.map((row) => [row.id, row.readAt?.toISOString()]));
  expect(stamps.get(already.id)).toBe(EARLIER.toISOString());
  expect([...stamps.values()].filter((stamp) => stamp === NOW.toISOString())).toHaveLength(
    MARK_READ_MAX - 1,
  );
});

test("a stranger's id in the batch is absent from the result and stays unread", async () => {
  const STRANGER = '00000000-0000-4000-8000-0000000000d3';
  const mine = await db.notifications.insert({ userId: OWNER, kind: 'message', actorId: ACTOR });
  const theirs = await db.notifications.insert({
    userId: STRANGER,
    kind: 'message',
    actorId: ACTOR,
  });

  const marked = await markRead(OWNER, [mine.id, theirs.id], NOW);

  expect(marked.map((row) => row.id)).toEqual([mine.id]);
  expect((await db.notifications.where({ id: theirs.id }).one())?.readAt).toBe(null);
});
