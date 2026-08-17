// unit — against the in-process driver, with a fixture graph of its own. It deliberately does NOT
// touch the demo seed: these cases WRITE, and a test that mutates the fixture every other test
// reads is a test that passes alone and fails in a suite.
//
// The failure cases come first. The mirror row is the one the schema cannot refuse, so it is the
// one the service has to.

import { beforeAll, expect, test } from 'bun:test';
import { db } from '@social-media-clone/db';
import { blockPerson, requestFriendship, respondToFriendship, unblockPerson } from './service';

const ANA = '00000000-0000-4000-8000-0000000000a1';
const BEN = '00000000-0000-4000-8000-0000000000b1';
const CAT = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-08-11T12:00:00Z');

const person = (id: string, handle: string) => ({
  id,
  handle,
  email: `${handle}@fixture.example`,
  displayName: handle,
  role: 'member' as const,
  createdAt: NOW,
  updatedAt: NOW,
});

beforeAll(async () => {
  await db.users.insert(person(ANA, 'fixture_ana'));
  await db.users.insert(person(BEN, 'fixture_ben'));
  await db.users.insert(person(CAT, 'fixture_cat'));
});

test('a request cannot be created when the MIRROR row already exists', async () => {
  await requestFriendship(BEN, ANA, NOW);

  // `(ANA→BEN)` and `(BEN→ANA)` are different composite keys, so the database would happily hold
  // both. This refusal is the only thing standing between the pair and two rows.
  await expect(requestFriendship(ANA, BEN, NOW)).rejects.toMatchObject({
    code: 'X_FRIEND_MIRROR_EXISTS',
    fix: `respondFriend({ requesterId: "${BEN}", decision: "accept" })`,
  });

  const rows = await db.friendships.limit(200).all();
  const pair = rows.filter(
    (row) =>
      [row.requesterId, row.addresseeId].includes(ANA) &&
      [row.requesterId, row.addresseeId].includes(BEN),
  );
  expect(pair).toHaveLength(1);
  expect(pair[0]?.requesterId).toBe(BEN);
});

test('the refusal names a call the caller can actually make', async () => {
  const answered = await respondToFriendship(ANA, BEN, true, NOW);
  expect(answered.status).toBe('accepted');
  expect(answered.respondedAt).toEqual(NOW);
  // Asking again once they are friends is a no-op, whichever way round the row points.
  await expect(requestFriendship(ANA, BEN, NOW)).resolves.toMatchObject({ status: 'accepted' });
});

test('answering a request that is not addressed to you finds nothing to answer', async () => {
  await requestFriendship(ANA, CAT, NOW);
  // CAT is the addressee; BEN answering reads `(ANA→BEN)`… which is not the row, so it is absent.
  await expect(respondToFriendship(CAT, BEN, true, NOW)).rejects.toMatchObject({
    code: 'X_FRIEND_NOT_FOUND',
  });
});

test('the graph has no self-edge, for either verb', async () => {
  await expect(requestFriendship(ANA, ANA, NOW)).rejects.toMatchObject({ code: 'X_FRIEND_SELF' });
  await expect(blockPerson(ANA, ANA, NOW)).rejects.toMatchObject({ code: 'X_FRIEND_SELF' });
});

test('blocking DECLINES the friendship in both directions rather than removing it', async () => {
  await blockPerson(ANA, BEN, NOW);

  const forward = await db.friendships.where({ requesterId: ANA, addresseeId: BEN }).one();
  const reverse = await db.friendships.where({ requesterId: BEN, addresseeId: ANA }).one();
  // Declined, not gone: the row is the only record of who asked, and `@ultimat3/entity` cannot
  // delete a composite-key row anyway. `respondedAt` is stamped because `pending` is the only
  // status the invariant lets carry a null.
  expect(reverse?.status).toBe('declined');
  expect(reverse?.respondedAt).toEqual(NOW);
  expect(forward).toBeNull();

  const block = await db.blocks.where({ blockerId: ANA, blockedId: BEN }).one();
  expect(block).not.toBeNull();
});

test('unblocking someone who is not blocked is false, not a refusal', async () => {
  // The failure case first: an idempotent lift has to answer for a state that is already true.
  // This threw `X_BLOCK_REMOVE_UNSUPPORTED` until 2026-08 — for a `deleteWhere` that already existed.
  expect(await unblockPerson(ANA, CAT)).toBe(false);
});

test('unblocking removes the block row, and says it did', async () => {
  await requestFriendship(CAT, BEN, NOW);
  await blockPerson(CAT, BEN, NOW);
  expect(await db.blocks.where({ blockerId: CAT, blockedId: BEN }).one()).not.toBeNull();

  expect(await unblockPerson(CAT, BEN)).toBe(true);
  expect(await db.blocks.where({ blockerId: CAT, blockedId: BEN }).one()).toBeNull();
  // The friendship stays declined: blocking settled it, and un-declining it would decide something
  // the pair never asked for.
  expect((await db.friendships.where({ requesterId: CAT, addresseeId: BEN }).one())?.status).toBe(
    'declined',
  );
});

test('unblocking yourself is the same non-edge blocking yourself is', async () => {
  await expect(unblockPerson(ANA, ANA)).rejects.toMatchObject({ code: 'X_FRIEND_SELF' });
});
