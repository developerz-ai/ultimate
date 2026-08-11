// unit — the two facts about the storage layer this feature is built on top of, pinned so neither
// can change without a failing test saying so.
//
// Both are about the COMPOSITE primary key. One is the mechanism the feature relies on (an insert
// is an upsert, which is what makes answering a request idempotent); the other is the hole it
// cannot work around (there is no delete at all).

import { expect, test } from 'bun:test';
import { db } from '@social-media-clone/db';

const OLA = '00000000-0000-4000-8000-0000000000d1';
const PIA = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-08-11T12:00:00Z');

test('writing the same composite key twice REPLACES the row — the key is the idempotency mechanism', async () => {
  await db.blocks.insert({ blockerId: OLA, blockedId: PIA, createdAt: NOW });
  await db.blocks.insert({ blockerId: OLA, blockedId: PIA, createdAt: NOW });
  const rows = await db.blocks.where({ blockerId: OLA, blockedId: PIA }).all();
  expect(rows).toHaveLength(1);
});

test('a block can be lifted: the gap this test used to pin is closed', async () => {
  // This was a PIN. It asserted `'deleteWhere' in db.blocks === false` and said "the signal to
  // rewrite unblockPerson and delete this test". @ultimat3/entity gained `deleteWhere(filter)`, the
  // pin flipped, and this is the rewrite — a pin that flips is the mechanism working, not a break.
  //
  // `delete(id)` still refuses, and correctly: a two-column key cannot be named by one id.
  await expect(db.blocks.delete(OLA)).rejects.toMatchObject({ code: 'X_INVARIANT_VIOLATED' });

  // An unbounded filter is refused too — an empty `where` on a write is not "touch nothing".
  await expect(db.blocks.deleteWhere({})).rejects.toMatchObject({ code: 'X_WRITE_UNFILTERED' });
});
