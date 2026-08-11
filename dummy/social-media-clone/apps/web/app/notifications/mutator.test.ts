// unit — the one property `local` must have and the one a lazy version loses: CONVERGENCE.
//
// `local` is replayed on every rebase, so applying it N times has to equal applying it once. The
// incremental spelling of an unread badge — `unread: count - 1` — passes a single-application test
// and goes negative on a device that drains its queue twice. That is why `read` is a boolean and
// the count is derived.

import { db } from '@social-media-clone/db';
import type { LocalTable, LocalTx } from '@ultimat3/action';
import { createContext, isUltimateError, userActor } from '@ultimat3/core';
import type { Actor } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { markNotificationsRead } from './mutator';
import * as repo from './repo';
import { unreadFor } from './service';

const ADA = '00000000-0000-4000-8000-0000000000a5';
const MARA = '00000000-0000-4000-8000-0000000000c5';

type LocalRow = { readonly id: string; readonly read: boolean };

/** A `LocalTx` over a Map — the shape @ultimat3/realtime implements over OPFS on a real client. */
const localStore = (seed: readonly LocalRow[]) => {
  const rows = new Map(seed.map((row) => [row.id, row]));
  const table: LocalTable<LocalRow> = {
    insert: (row) => {
      rows.set(row.id, row);
    },
    update: (id, patch) => {
      const current = rows.get(id);
      if (current === undefined) return;
      rows.set(id, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
  const tx = { notifications: table, table: () => table } as unknown as LocalTx;
  return { tx, rows, unread: () => [...rows.values()].filter((row) => !row.read).length };
};

const member = (id: string): Actor => ({
  ...userActor({ id }),
  permissions: ['notification:read', 'notification:mark-read'],
});

// Named here because every projection needs a stable name and this file does not boot the app.
const target = markNotificationsRead.named('markNotificationsRead');

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return 'no error';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

unitTest('applying local THREE times equals applying it once', () => {
  const store = localStore([
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: false },
  ]);
  const once = localStore([
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: false },
  ]);

  const input = { ids: ['n1', 'n2'] };
  target.local(once.tx, input);
  for (let attempt = 0; attempt < 3; attempt += 1) target.local(store.tx, input);

  expect([...store.rows.values()]).toEqual([...once.rows.values()]);
  // The count that would have gone wrong: derived from the booleans, never decremented.
  expect(store.unread()).toBe(1);
  expect(store.unread()).toBe(once.unread());
});

unitTest('local reads no clock and no randomness, so a replay produces the same row', () => {
  const first = localStore([{ id: 'n1', read: false }]);
  const second = localStore([{ id: 'n1', read: false }]);
  target.local(first.tx, { ids: ['n1'] });
  target.local(second.tx, { ids: ['n1'] });
  // Byte-identical between two independent applications — a `Date.now()` in `local` breaks this.
  expect(JSON.stringify([...first.rows.values()])).toBe(JSON.stringify([...second.rows.values()]));
});

unitTest('an anonymous caller marks nothing read', async () => {
  const mine = await repo.insertNotification({ userId: ADA, kind: 'message', actorId: MARA });
  expect(
    await codeOf(
      target({ ids: [mine.id] }, { ctx: createContext(), actor: null, surface: 'http' }),
    ),
  ).toBe('X_UNAUTHENTICATED');
  expect(await unreadFor(ADA)).toBe(1);
});

unitTest("a batch naming somebody else's notification cannot touch it", async () => {
  const mine = await repo.inboxPage(ADA);
  const theirs = await repo.insertNotification({ userId: MARA, kind: 'message', actorId: ADA });
  const ctx = createContext({ actor: member(ADA) });

  const result = await target(
    { ids: [mine[0]?.id ?? '', theirs.id] },
    { ctx, actor: member(ADA), surface: 'http' },
  );

  // Short by exactly the row that was not the caller's: the write is scoped by `userId`, so a
  // foreign id is ABSENT rather than refused-and-then-written. `MutatorDef` carries no `row`
  // loader (packages/action/src/mutator.ts:66), so the scope is the enforcement — and the count is
  // the most a caller may learn about rows that are not theirs.
  expect(result.marked).toBe(1);
  expect(await unreadFor(ADA)).toBe(0);
  expect(await unreadFor(MARA)).toBe(1);
});

unitTest('the server half is convergent too: three calls leave one readAt', async () => {
  const row = await repo.insertNotification({ userId: MARA, kind: 'post-liked', actorId: ADA });
  const ctx = createContext({ actor: member(MARA) });
  const call = () => target({ ids: [row.id] }, { ctx, actor: member(MARA), surface: 'http' });
  const before = await unreadFor(MARA);

  await call();
  const first = await db.notifications.where({ id: row.id }).one();
  await call();
  await call();
  const third = await db.notifications.where({ id: row.id }).one();

  expect(first?.readAt).not.toBe(null);
  // The timestamp did not move, so replaying the mutation is a no-op rather than a rewrite.
  expect(third?.readAt?.toISOString()).toBe(first?.readAt?.toISOString());
  // Three calls, exactly one row moved out of "unread" — the derived count converges too.
  expect(await unreadFor(MARA)).toBe(before - 1);
});
