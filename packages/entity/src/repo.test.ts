import { afterAll, describe, expect, test } from 'bun:test';
import { decodeCursor } from '@ultimat3/core';
import { integer, text, timestamp, uuid } from './columns';
import { planScope } from './cursor';
import { entity } from './entity';
import { invariant } from './invariants';
import { planFor } from './plan';
import { clearRegistry } from './registry';
import type { FindManyArgs } from './repo';
import { memoryRepo, memoryTransactor } from './repo';

const notes = entity('repo_test_notes', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    deletedAt: timestamp().nullable(),
  },
});

type Note = typeof notes.$row;

const org = (index: number): string => `00000000-0000-7000-8000-00000000000${index}`;

const seed: readonly Note[] = ['a', 'b', 'c', 'd', 'e'].map((title, index) => ({
  id: `00000000-0000-7000-8000-00000000010${index}`,
  orgId: index < 4 ? org(1) : org(2),
  title,
  deletedAt: null,
}));

const ids = seed.map((note) => note.id);

afterAll(() => {
  clearRegistry();
});

describe('tenancy guard', () => {
  test('a query for a tenant-scoped entity without an org rejects', async () => {
    const repo = memoryRepo(notes, seed);
    await expect(repo.findMany()).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
    await expect(repo.findById(ids[0] ?? '')).rejects.toThrow(/X_TENANCY_UNSCOPED|org predicate/);
    await expect(repo.count()).rejects.toThrow(/X_TENANCY_UNSCOPED/);
  });

  test('scoped reads only see their own tenant', async () => {
    const repo = memoryRepo(notes, seed);
    const page = await repo.findMany({ orgId: org(1), limit: 10 });
    expect(page.rows).toHaveLength(4);
    expect(page.rows.every((row) => row.orgId === org(1))).toBe(true);
    expect(await repo.count({ orgId: org(2) })).toBe(1);
  });
});

describe('cursor pagination', () => {
  /** The scope a cursor for these arguments is signed with — see `planScope`. */
  const scopeOf = (args: FindManyArgs): string => planScope(planFor(notes, args));

  test('walks every row exactly once', async () => {
    const repo = memoryRepo(notes, seed);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await repo.findMany({ orgId: org(1), limit: 2, cursor });
      seen.push(...result.rows.map((row) => row.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(ids.slice(0, 4));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('the cursor names a position in the sort order, never a row count', async () => {
    const repo = memoryRepo(notes, seed);
    const args = { orgId: org(1), limit: 2 };
    const first = await repo.findMany(args);
    expect(decodeCursor(first.nextCursor ?? '', scopeOf(args)).id).toBe(ids[1] ?? '');
    // An insert before the page boundary must not shift the next page — the failure OFFSET has.
    await repo.insert({
      id: '00000000-0000-7000-8000-000000000999',
      orgId: org(1),
      title: 'inserted first',
      deletedAt: null,
    });
    const second = await repo.findMany({ orgId: org(1), limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2, 4));
  });

  test('the last page reports no cursor', async () => {
    const repo = memoryRepo(notes, seed);
    expect((await repo.findMany({ orgId: org(1), limit: 10 })).nextCursor).toBeNull();
  });

  // Every one of these used to be a silent page one: the old codec answered `null` and the
  // caller read that as "no cursor", so a tampered or borrowed bookmark restarted the listing
  // instead of saying so.
  test('a tampered cursor is refused, never served as page one', async () => {
    const repo = memoryRepo(notes, seed);
    const { nextCursor } = await repo.findMany({ orgId: org(1), limit: 2 });
    const [body = '', signature = ''] = (nextCursor ?? '').split('.');
    // Flipped to a digit the signature does not already end in: `+ '0'` on one that ends in `0`
    // is not a tamper, and the case would pass one run in sixteen for the wrong reason.
    const flipped = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

    for (const cursor of [`${body}x.${signature}`, `${body}.${flipped}`, 'garbage', '']) {
      await expect(repo.findMany({ orgId: org(1), limit: 2, cursor })).rejects.toBeUltimateError(
        'X_CURSOR_INVALID',
      );
    }
  });

  test('a cursor from another tenant cannot page this one', async () => {
    const repo = memoryRepo(notes, seed);
    const other = await repo.findMany({ orgId: org(2), limit: 1 });
    // org(2) has one row, so it hands back no cursor: forge the position it would name.
    expect(other.nextCursor).toBeNull();
    const mine = await repo.findMany({ orgId: org(1), limit: 2 });
    await expect(
      repo.findMany({ orgId: org(2), limit: 2, cursor: mine.nextCursor }),
    ).rejects.toBeUltimateError('X_CURSOR_INVALID');
  });

  test('a cursor from another sort order cannot page this one', async () => {
    const repo = memoryRepo(notes, seed);
    const byId = await repo.findMany({ orgId: org(1), limit: 2 });
    await expect(
      repo.findMany({
        orgId: org(1),
        limit: 2,
        cursor: byId.nextCursor,
        orderBy: [{ column: 'title', direction: 'desc' }],
      }),
    ).rejects.toBeUltimateError('X_CURSOR_INVALID');
  });

  test('a bigger next page is not a different query — the cursor still works', async () => {
    const repo = memoryRepo(notes, seed);
    const first = await repo.findMany({ orgId: org(1), limit: 2 });
    const second = await repo.findMany({ orgId: org(1), limit: 10, cursor: first.nextCursor });
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2, 4));
  });
});

// Each of these is a place the in-memory driver used to mean something Postgres does not.
// A divergence here is the worst kind of bug the framework can ship: the test is green and
// production is wrong.
describe('semantics shared with the Postgres driver', () => {
  const events = entity('repo_test_events', {
    columns: { id: uuid().primaryKey(), label: text(), at: timestamp() },
  });
  const AT = new Date('2026-03-04T05:06:07.000Z');
  const rows = [
    { id: org(1), label: 'draft-one', at: AT },
    { id: org(2), label: 'published-two', at: new Date('2026-03-05T00:00:00.000Z') },
  ];

  test('equality on a timestamp compares the instant, not the object', async () => {
    const repo = memoryRepo(events, rows);
    const page = await repo.findMany({ where: [{ column: 'at', op: 'eq', value: new Date(AT) }] });
    expect(page.rows.map((row) => row.id)).toEqual([org(1)]);
  });

  test('an in-list of timestamps matches by instant too', async () => {
    const repo = memoryRepo(events, rows);
    const page = await repo.findMany({
      where: [{ column: 'at', op: 'in', value: [new Date(AT)] }],
    });
    expect(page.rows).toHaveLength(1);
  });

  test('like is a SQL pattern, not a substring test', async () => {
    const repo = memoryRepo(events, rows);
    const anchored = await repo.findMany({
      where: [{ column: 'label', op: 'like', value: 'draft%' }],
    });
    expect(anchored.rows.map((row) => row.label)).toEqual(['draft-one']);
    // A bare pattern anchors at both ends, exactly as `like 'draft'` does in Postgres.
    expect(
      (await repo.findMany({ where: [{ column: 'label', op: 'like', value: 'draft' }] })).rows,
    ).toHaveLength(0);
    expect(
      (await repo.findMany({ where: [{ column: 'label', op: 'like', value: '%-t_o' }] })).rows,
    ).toHaveLength(1);
  });

  test('a soft-deleted row is hidden from writes, not just from reads', async () => {
    const repo = memoryRepo(notes, seed);
    const id = ids[0] ?? '';
    await repo.delete(id, { orgId: org(1) });
    await expect(repo.delete(id, { orgId: org(1) })).rejects.toBeUltimateError('X_NOT_FOUND');
    await expect(repo.update(id, { title: 'zombie' }, { orgId: org(1) })).rejects.toBeUltimateError(
      'X_NOT_FOUND',
    );
  });

  test('the page after a deleted boundary row continues, it does not restart', async () => {
    const repo = memoryRepo(notes, seed);
    const first = await repo.findMany({ orgId: org(1), limit: 2 });
    // The row the cursor was taken from disappears between the two requests. Seeking by its id
    // would find nothing and silently serve page one again.
    await repo.delete(ids[1] ?? '', { orgId: org(1) });
    const second = await repo.findMany({ orgId: org(1), limit: 2, cursor: first.nextCursor });
    expect(second.rows.map((row) => row.id)).toEqual(ids.slice(2, 4));
  });

  test('a cursor survives a sort value that is not latin-1', async () => {
    const repo = memoryRepo(events, [
      { id: org(1), label: 'café — piñata 🎉', at: AT },
      { id: org(2), label: 'zulu', at: AT },
    ]);
    const args = { limit: 1, orderBy: [{ column: 'label', direction: 'asc' as const }] };
    const first = await repo.findMany(args);
    expect(first.nextCursor).not.toBeNull();
    const decoded = decodeCursor(first.nextCursor ?? '', planScope(planFor(events, args)));
    expect(decoded.key[0]).toBe('café — piñata 🎉');
    const second = await repo.findMany({
      limit: 1,
      orderBy: [{ column: 'label', direction: 'asc' }],
      cursor: first.nextCursor,
    });
    expect(second.rows.map((row) => row.label)).toEqual(['zulu']);
  });
});

describe('writes', () => {
  test('soft delete hides the row without losing it', async () => {
    const repo = memoryRepo(notes, seed);
    await repo.delete(ids[0] ?? '', { orgId: org(1) });
    expect(await repo.count({ orgId: org(1) })).toBe(3);
    expect(await repo.count({ orgId: org(1), includeDeleted: true })).toBe(4);
    // `delete()`'s soft-delete write stamps a real `Date`, read through `systemClock.now()`
    // rather than an ambient `new Date()`.
    const stamped = (
      await repo.findMany({ orgId: org(1), includeDeleted: true, limit: 10 })
    ).rows.find((row) => row.id === (ids[0] ?? ''));
    expect(stamped?.deletedAt).toBeInstanceOf(Date);
  });

  test('deleteWhere() stamps a real Date on every row it soft-deletes', async () => {
    const repo = memoryRepo(notes, seed);
    expect(await repo.deleteWhere({ orgId: org(1) })).toBe(4);
    const all = (await repo.findMany({ orgId: org(1), includeDeleted: true, limit: 10 })).rows;
    expect(all).toHaveLength(4);
    for (const row of all) expect(row.deletedAt).toBeInstanceOf(Date);
  });

  test('a failed transaction undoes its writes', async () => {
    const repo = memoryRepo(notes, seed);
    const transactor = memoryTransactor();
    const attempt = transactor.run(async (tx) => {
      await repo.update(ids[0] ?? '', { title: 'changed' }, { tx, orgId: org(1) });
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect((await repo.findById(ids[0] ?? '', { orgId: org(1) }))?.title).toBe('a');
  });

  test('an update through the outbox tx is visible to the same tx', async () => {
    const repo = memoryRepo(notes, seed);
    const transactor = memoryTransactor();
    const title = await transactor.run(async (tx) => {
      await repo.update(ids[0] ?? '', { title: 'changed' }, { tx, orgId: org(1) });
      return (await repo.findById(ids[0] ?? '', { orgId: org(1) }))?.title;
    });
    expect(title).toBe('changed');
  });

  test('a composite key has no single id, and says so instead of guessing', async () => {
    const likes = entity('repo_test_likes', {
      columns: { postId: uuid(), memberId: uuid(), label: text().nullable() },
      primaryKey: ['postId', 'memberId'],
    });
    const repo = memoryRepo(likes);
    await repo.insert({ postId: org(1), memberId: org(2), label: null });
    expect((await repo.findMany({ limit: 10 })).rows).toHaveLength(1);
    await expect(repo.findById(org(1))).rejects.toThrow(/composite primary key/);

    // The row an id cannot name is still writable, both ways, and the count is how the caller
    // knows it landed. Neither of these existed before: the entity was create-only.
    expect(await repo.updateWhere({ postId: org(1), memberId: org(2) }, { label: 'seen' })).toBe(1);
    expect((await repo.findMany({ limit: 10 })).rows[0]?.label).toBe('seen');
    expect(await repo.deleteWhere({ postId: org(1), memberId: org(2) })).toBe(1);
    expect((await repo.findMany({ limit: 10 })).rows).toHaveLength(0);

    // No `deletedAt` column, so this is a real removal — and a failed unit of work puts it back.
    await repo.insert({ postId: org(1), memberId: org(2), label: null });
    const rolledBack = memoryTransactor().run(async (tx) => {
      expect(await repo.deleteWhere({ postId: org(1) }, { tx })).toBe(1);
      throw new Error('boom');
    });
    await expect(rolledBack).rejects.toThrow('boom');
    expect((await repo.findMany({ limit: 10 })).rows).toHaveLength(1);
  });

  test('a failed transaction un-stamps every row deleteWhere soft-deleted', async () => {
    const repo = memoryRepo(notes, seed);
    const attempt = memoryTransactor().run(async (tx) => {
      // A whole tenant at once: the undo has to restore all four, and the stamps are already
      // written by the time the throw happens.
      expect(await repo.deleteWhere({ orgId: org(1) }, { tx, orgId: org(1) })).toBe(4);
      expect(await repo.count({ tx, orgId: org(1) })).toBe(0);
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect(await repo.count({ orgId: org(1) })).toBe(4);
  });

  test('a failed transaction restores every row updateWhere patched', async () => {
    const repo = memoryRepo(notes, seed);
    const attempt = memoryTransactor().run(async (tx) => {
      expect(
        await repo.updateWhere({ orgId: org(1) }, { title: 'bulk' }, { tx, orgId: org(1) }),
      ).toBe(4);
      expect((await repo.findById(ids[0] ?? '', { tx, orgId: org(1) }))?.title).toBe('bulk');
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect((await repo.findById(ids[0] ?? '', { orgId: org(1) }))?.title).toBe('a');
  });
});

// A batch is one statement in Postgres and one loop here, and the two have to resolve a collision
// the same way — same conflict target, same columns written, same refusal — or a green test here
// is a production bug there.
describe('many-row writes', () => {
  const members = entity('repo_test_bulk_members', {
    columns: {
      id: uuid().primaryKey(),
      email: text().unique(),
      // Nullable and unique: the one target whose key can be absent, which is a different
      // question from "which row does it match".
      handle: text().nullable().unique(),
      nickname: text(),
      visits: integer(),
    },
    invariants: (c) => [invariant('nickname_present', c.nickname.minLength(1))],
  });
  type Member = typeof members.$row;

  const memberId = (index: number): string => `00000000-0000-7000-8000-00000000020${index}`;
  const member = (index: number, over: Partial<Member> = {}): Member => ({
    id: memberId(index),
    email: `member-${index}@example.test`,
    handle: null,
    nickname: `m${index}`,
    visits: index,
    ...over,
  });

  test('a batch writes every row, in the order it was given', async () => {
    const repo = memoryRepo(members);
    const written = await repo.insertAll([member(3), member(1), member(2)]);
    expect(written.map((row) => row.id)).toEqual([memberId(3), memberId(1), memberId(2)]);
    expect(await repo.count()).toBe(3);
    // An empty batch writes nothing and is not an error — a caller filtering a list to nothing
    // should not have to branch around the call.
    expect(await repo.insertAll([])).toEqual([]);
    expect(await repo.count()).toBe(3);
  });

  test('an invariant judges every row of the batch, not just the first', async () => {
    const repo = memoryRepo(members);
    await expect(
      repo.insertAll([member(1), member(2, { nickname: '' })]),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    // Nothing landed, and that is the rule both drivers hold to: `insertAll` asserts every row
    // before its first `write`, `writeRows` before its first statement. Pinned here because an
    // untested rule is one a refactor deletes — move `$assert` into `write()` and this batch
    // half-applies while every other test stays green.
    expect(await repo.count()).toBe(0);
  });

  test('an upsert with nothing to collide with is an insert', async () => {
    const repo = memoryRepo(members);
    const written = await repo.upsertAll([member(1), member(2)], { onConflict: ['email'] });
    expect(written.map((row) => row.id)).toEqual([memberId(1), memberId(2)]);
    expect(await repo.count()).toBe(2);
  });

  test('a collision keeps the stored row in place and writes the rest of the columns', async () => {
    const repo = memoryRepo(members, [member(1)]);
    const [written] = await repo.upsertAll(
      [member(9, { email: member(1).email, nickname: 'renamed', visits: 42 })],
      { onConflict: ['email'] },
    );
    // The conflict target is not the primary key, so the incoming row carries an id of its own —
    // taking it would move the row every foreign key already points at.
    expect(written?.id).toBe(memberId(1));
    expect(written?.email).toBe(member(1).email);
    expect(written?.nickname).toBe('renamed');
    expect(written?.visits).toBe(42);
    expect(await repo.count()).toBe(1);
    expect(await repo.findById(memberId(9))).toBeNull();
  });

  test('onMatch nothing keeps the stored row exactly, and says so by omitting it', async () => {
    const repo = memoryRepo(members, [member(1)]);
    const written = await repo.upsertAll(
      [member(9, { email: member(1).email, nickname: 'ignored', visits: 99 }), member(2)],
      { onConflict: ['email'], onMatch: 'nothing' },
    );
    // `returning *` under `do nothing` names no row, so a skipped row is absent from the result
    // rather than present and unchanged: the result is always "the rows this call wrote".
    expect(written.map((row) => row.id)).toEqual([memberId(2)]);
    expect(await repo.findById(memberId(1))).toEqual(member(1));
  });

  test('two rows of one batch under nothing insert once — the second sees the first', async () => {
    const repo = memoryRepo(members);
    const written = await repo.upsertAll([member(1), member(2, { email: member(1).email })], {
      onConflict: ['email'],
      onMatch: 'nothing',
    });
    expect(written.map((row) => row.id)).toEqual([memberId(1)]);
    expect(await repo.count()).toBe(1);
  });

  test('two rows of one batch under update are refused before the first is written', async () => {
    const repo = memoryRepo(members);
    // Postgres answers this with 21000 rather than writing one of the two, so nothing may land
    // here either — a partial batch is the outcome neither driver is allowed to produce.
    await expect(
      repo.upsertAll([member(1), member(2, { email: member(1).email })], { onConflict: ['email'] }),
    ).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(await repo.count()).toBe(0);
  });

  test('a null conflict target matches nothing, stored or in the batch', async () => {
    // A Postgres unique index is `NULLS DISTINCT`, so a null handle is not a value two rows can
    // share: neither row lands on the stored one, and neither lands on the other.
    const repo = memoryRepo(members, [member(1)]);
    const written = await repo.upsertAll([member(2), member(3)], { onConflict: ['handle'] });
    expect(written.map((row) => row.id)).toEqual([memberId(2), memberId(3)]);
    expect(await repo.count()).toBe(3);
  });

  test('a conflict target is required, and checked on a batch with no rows in it', async () => {
    const repo = memoryRepo(members);
    await expect(repo.upsertAll([], { onConflict: [] })).rejects.toBeUltimateError(
      'X_INVARIANT_VIOLATED',
    );
    expect(await repo.upsertAll([], { onConflict: ['email'] })).toEqual([]);
  });

  test('a failed transaction undoes the whole batch, insert and upsert alike', async () => {
    const repo = memoryRepo(members, [member(1)]);
    const attempt = memoryTransactor().run(async (tx) => {
      await repo.insertAll([member(2), member(3)], { tx });
      // `UpsertArgs extends RepoOptions`, so the args ARE the options — one bag, and the undo is
      // registered by the same write every other path here goes through.
      await repo.upsertAll([member(9, { email: member(1).email, visits: 99 })], {
        tx,
        onConflict: ['email'],
      });
      expect(await repo.count({ tx })).toBe(3);
      throw new Error('boom');
    });
    await expect(attempt).rejects.toThrow('boom');
    expect((await repo.findMany({ limit: 10 })).rows).toEqual([member(1)]);
  });

  test('a soft-deleted row still occupies its conflict key', async () => {
    // The unique index it would collide with in Postgres is not partial, so a deleted row is a
    // collision here too. `nothing` is what makes the two answers tell each other apart: indexed,
    // the incoming row is skipped and the stamp survives; missed, it would be written on top.
    const repo = memoryRepo(notes, seed);
    const stamped = ids[0] ?? '';
    await repo.delete(stamped, { orgId: org(1) });
    const written = await repo.upsertAll(
      [{ id: stamped, orgId: org(1), title: 'usurper', deletedAt: null }],
      { onConflict: ['id'], onMatch: 'nothing', orgId: org(1) },
    );
    expect(written).toEqual([]);
    expect(await repo.count({ orgId: org(1) })).toBe(3);
    const all = await repo.findMany({ orgId: org(1), includeDeleted: true, limit: 10 });
    expect(all.rows).toHaveLength(4);
    expect(all.rows.find((row) => row.id === stamped)?.title).toBe('a');
  });
});
