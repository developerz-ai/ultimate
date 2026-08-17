// unit — the facts about the storage layer this feature is built on top of, pinned so none can
// change without a failing test saying so.
//
// Two are about the COMPOSITE primary key: writing one twice is one row, and removing one takes
// `deleteWhere` because no single id can name it. The third is the page bound the screen depends on.

import { expect, test } from 'bun:test';
import { db } from '@social-media-clone/db';
import { peopleByIds, removeBlock, saveBlock } from './repo';

const OLA = '00000000-0000-4000-8000-0000000000d1';
const PIA = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-08-11T12:00:00Z');

test('writing the same composite key twice is ONE row — the key is the idempotency mechanism', async () => {
  await saveBlock({ blockerId: OLA, blockedId: PIA, createdAt: NOW });
  await saveBlock({ blockerId: OLA, blockedId: PIA, createdAt: NOW });
  const rows = await db.blocks.where({ blockerId: OLA, blockedId: PIA }).all();
  expect(rows).toHaveLength(1);
  await removeBlock(OLA, PIA);
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

test('peopleByIds answers for every id it was given, past the 100-row page', async () => {
  // 120 people — more than the `PAGE` this call used to cap itself at, fewer than the 300 the
  // friends screen can union. Under the old `limit(PAGE)` the last 20 came back absent, and the
  // screen dropped their rows silently: `viewOf` renders nothing for a person it cannot find.
  const ids: string[] = [];
  for (let index = 0; index < 120; index += 1) {
    const handle = `crowd_${index.toString().padStart(3, '0')}`;
    const row = await db.users.insert({
      handle,
      email: `${handle}@fixture.example`,
      displayName: handle,
      role: 'member',
    });
    ids.push(row.id);
  }

  const people = await peopleByIds(ids);
  expect(people.size).toBe(ids.length);
});
