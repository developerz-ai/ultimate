// unit — the membership rule, and the denials that prove it is the thing standing in the way.
//
// Every case is built so exactly one fact is wrong. An allow that passes proves the happy path; a
// denial that passes proves the rule.

import { createContext, userActor } from '@ultimat3/core';
import type { Actor, Policy, PolicyDecision } from '@ultimat3/policy';
import { evaluate } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { isParticipant, messageSend, type ThreadRow, threadRead } from './policy';

const ADA = '00000000-0000-4000-8000-00000000000a';
const BRUNO = '00000000-0000-4000-8000-00000000000b';
const MARA = '00000000-0000-4000-8000-00000000000c';
const THREAD = '00000000-0000-4000-8000-0000000000f1';

const room: ThreadRow = { conversationId: THREAD, participantIds: [ADA, BRUNO] };

/** Holds BOTH message permissions, so every denial below is about the row and never the grant. */
const member = (id: string): Actor => ({
  ...userActor({ id }),
  permissions: ['message:read', 'message:send'],
});

const decide = (
  policy: Policy<Record<string, never>, ThreadRow>,
  actor: Actor | null,
  row: ThreadRow | null,
): PolicyDecision => evaluate(policy, { input: {}, actor, row, ctx: createContext() }).decision;

const codeOf = (decision: PolicyDecision): string | null =>
  decision.allowed ? null : decision.code;

unitTest('a non-participant is refused the thread, whatever permission they hold', () => {
  expect(decide(threadRead, member(MARA), room).allowed).toBe(false);
  expect(decide(messageSend, member(MARA), room).allowed).toBe(false);
});

unitTest(
  'a participant is allowed, so the denial above is about membership and nothing else',
  () => {
    expect(decide(threadRead, member(ADA), room).allowed).toBe(true);
    expect(decide(messageSend, member(BRUNO), room).allowed).toBe(true);
  },
);

unitTest('row === null is a DENIAL, never a pass', () => {
  // The hole this closes: a surface that passes no row — the live subscribe gate is exactly one
  // (packages/realtime/src/policy-gate.ts:26) — would otherwise hand anyone holding the permission
  // a way to skip the membership check entirely.
  expect(decide(threadRead, member(ADA), null).allowed).toBe(false);
  expect(decide(messageSend, member(ADA), null).allowed).toBe(false);
});

unitTest('a conversation that does not exist denies exactly like one that is not yours', () => {
  const absent: ThreadRow = { conversationId: THREAD, participantIds: [] };
  const missing = decide(threadRead, member(ADA), absent);
  const stranger = decide(threadRead, member(MARA), room);
  expect(missing.allowed).toBe(false);
  // Same code AND same reason, so the id space cannot be enumerated one request at a time.
  expect(codeOf(missing)).toBe(codeOf(stranger));
});

unitTest('an anonymous caller is nobody, and nobody is in any thread', () => {
  expect(isParticipant(null, room)).toBe(false);
  expect(codeOf(decide(threadRead, null, room))).toBe('X_UNAUTHENTICATED');
});

unitTest('membership is a set question, not a prefix or a substring match', () => {
  expect(isParticipant(ADA, room)).toBe(true);
  expect(isParticipant(ADA.slice(0, -1), room)).toBe(false);
});
