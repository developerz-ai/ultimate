// unit — no DB, no I/O, which is the whole point: these predicates are synchronous so a live query
// can re-evaluate one per subscriber per change. Every surface runs exactly what is tested here.
//
// The cases that matter are the DENIALS. An allow proves the happy path; a denial proves the rule
// is the thing standing in the way, and each case below is built so exactly one fact is wrong.

import { expect, test } from 'bun:test';
import { userId } from '@social-media-clone/domain';
import { evaluate } from '@ultimat3/policy';
import type { Actor } from '../../shared/actor';
import { viewerActor } from '../../shared/actor';
import type { BlockRow, FriendshipRow } from './policy';
import { canRemoveBlock, canRequestFriendship, canRespondToRequest, friendRespond } from './policy';

const ADA = userId('00000000-0000-4000-8000-00000000000a');
const BRUNO = userId('00000000-0000-4000-8000-00000000000b');
const MARA = userId('00000000-0000-4000-8000-00000000000c');

// Built by the app's ONE actor constructor, so a fact this rule reads is a fact production puts
// there — a literal would keep passing after the seam moved underneath it.
const actor = (
  id = ADA,
  friends: readonly ReturnType<typeof userId>[] = [],
  blocked: readonly ReturnType<typeof userId>[] = [],
): Actor => viewerActor({ id, role: 'member', friendIds: friends, blockedIds: blocked });

const request = (over: Partial<FriendshipRow> = {}): FriendshipRow => ({
  requesterId: BRUNO,
  addresseeId: ADA,
  status: 'pending',
  ...over,
});

test('ONLY the addressee may respond — the requester holding the grant may not accept their own', () => {
  expect(canRespondToRequest(actor(ADA), request())).toBe(true);
  // The regression this exists to prevent: a symmetric "either party" check waves this through,
  // and anyone can befriend anyone by asking and then answering.
  expect(canRespondToRequest(actor(BRUNO), request())).toBe(false);
  expect(canRespondToRequest(actor(MARA), request())).toBe(false);
  expect(canRespondToRequest(null, request())).toBe(false);
});

test('an accepted row is not answerable again; a declined one is', () => {
  expect(canRespondToRequest(actor(ADA), request({ status: 'accepted' }))).toBe(false);
  // The pair gets ONE row, so a declined row that could never be answered would be a dead end no
  // sequence of calls could leave.
  expect(canRespondToRequest(actor(ADA), request({ status: 'declined' }))).toBe(true);
});

test('the whole `friendRespond` policy denies a row addressed to somebody else', () => {
  // ONE actor in, no ambient anything: the rule reads the argument it is handed, which is what
  // lets the identical object decide on a sync node, in a job and inside an MCP tool.
  const decide = (viewer: Actor | null, row: FriendshipRow | null): boolean =>
    evaluate(friendRespond, {
      input: {},
      // The permission is a DIRECT grant rather than the `member` role: role definitions are
      // process-global, so leaning on them here would make this file pass or fail on whichever
      // other test module happened to import `app/auth/roles.ts` first.
      actor: viewer === null ? null : { ...viewer, permissions: ['friend:respond'] },
      row,
    }).allowed;

  expect(decide(actor(ADA), request())).toBe(true);
  expect(decide(actor(ADA), request({ addresseeId: MARA }))).toBe(false);
  // `row === null` is a DENIAL, never a pass: an absent fact is not a satisfied one, and treating
  // it as one hands anyone holding `friend:respond` a surface that skips the row check entirely.
  expect(decide(actor(ADA), null)).toBe(false);
});

test('a block refuses a friend request in EITHER direction, and so does self', () => {
  expect(canRequestFriendship(actor(ADA), BRUNO)).toBe(true);
  // `blockedIds` is symmetric by construction — it holds who this actor blocked AND who blocked
  // them — so one set answers both directions.
  expect(canRequestFriendship(actor(ADA, [], [BRUNO]), BRUNO)).toBe(false);
  expect(canRequestFriendship(actor(ADA), ADA)).toBe(false);
  expect(canRequestFriendship(null, BRUNO)).toBe(false);
});

test('only the person who placed a block may lift it', () => {
  const row: BlockRow = { blockerId: MARA, blockedId: ADA };
  expect(canRemoveBlock(actor(MARA), row)).toBe(true);
  // Being the blocked party is not a grant. If it were, a block would be a suggestion.
  expect(canRemoveBlock(actor(ADA), row)).toBe(false);
  expect(canRemoveBlock(null, row)).toBe(false);
});
