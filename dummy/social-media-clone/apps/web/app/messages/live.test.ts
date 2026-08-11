// live — the two properties a subscribable read must have, asserted against the descriptor the
// sync node actually subscribes to rather than against the source text.
//
// Bounded, and totally ordered. The matcher decides a row's position from `orderBy` alone
// (packages/query/src/matcher.ts), so a partial order lets two rows swap between evaluations and a
// bounded page silently drops or repeats one at its boundary.

import { createContext, userActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { expect, liveTest, unitTest } from '@ultimat3/testing';
import { liveThread } from './live';
import { THREAD_PAGE } from './repo';

const ROOM = '00000000-0000-4000-8000-0000000000f3';
const ADA = '00000000-0000-4000-8000-0000000000a3';

// Named here because a descriptor needs a stable name and this file does not boot the app.
const target = liveThread.named('liveThread');

const describeQuery = () =>
  // `enforce: false` is what a sync node passes when it builds the SUBJECT-LESS window; the
  // per-subscriber decision is `authorize` below, asserted separately.
  target.live({ conversationId: ROOM }, { ctx: createContext(), enforce: false });

liveTest('the thread is bounded — a subscription window cannot grow without end', async () => {
  const live = await describeQuery();
  expect(live.limit).toBe(THREAD_PAGE);
  expect(live.shape.limit).toBe(THREAD_PAGE);
});

liveTest('the order is TOTAL: the last sort key is unique in the row shape', async () => {
  const live = await describeQuery();
  const columns = live.shape.orderBy.map((key) => key.column);
  expect(columns).toEqual(['createdAt', 'id']);
  // Newest first, and the tail key ascending — the same plan `messages`' index is built for.
  expect(live.shape.orderBy[0]?.direction).toBe('desc');
  expect(live.shape.orderBy.at(-1)?.column).toBe('id');
});

liveTest(
  'the matcher can patch this shape — no unsupported feature reaches a subscriber',
  async () => {
    const live = await describeQuery();
    expect(live.shape.unsupported).toEqual([]);
    expect(live.reads).toContain('messages');
  },
);

liveTest('subscribing with no row is REFUSED, including for a real participant', async () => {
  const live = await describeQuery();
  const member: Actor = { ...userActor({ id: ADA }), permissions: ['message:read'] };
  // This is the honest state of the seam, pinned so a change to it is visible: the sync node's
  // subscribe gate passes `row: null` unconditionally (packages/realtime/src/policy-gate.ts:26),
  // and membership denies without the row. Fail-closed, never a hole — and the topic guard in
  // `topics.ts`, which is async, is where chat authorization is enforced for real today.
  await expect(
    live.authorize({
      actor: member,
      input: { conversationId: ROOM },
      ctx: createContext(),
      query: 'liveThread',
    }),
  ).rejects.toThrow();
});

unitTest('the read is declared live, so it is registered as subscribable at boot', () => {
  expect(target.isLive).toBe(true);
  expect(target.describe().live).toBe(true);
});
