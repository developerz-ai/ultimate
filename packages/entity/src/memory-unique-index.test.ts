// Single responsibility: the memory driver's unique index is kept as rows move, not rebuilt per
// write — a single write costs its own keys, and every way a row leaves or returns (update, delete,
// soft delete, rollback, reset) moves its keys with it, so a refusal answers what Postgres answers.
import { afterAll, describe, expect, test } from 'bun:test';
import { text, timestamp } from './columns';
import { entity } from './entity';
import { memoryRepo, memoryTransactor } from './memory-repo';
import { clearRegistry } from './registry';
import type { Tx } from './repo';

afterAll(() => {
  clearRegistry();
});

const members = entity('mui_members', {
  columns: { id: text().primaryKey(), email: text(), handle: text().nullable() },
  indexes: [
    { on: ['email'], unique: true },
    { on: ['handle'], unique: true },
  ],
});

const notes = entity('mui_notes', {
  columns: { id: text().primaryKey(), slug: text(), deletedAt: timestamp().nullable() },
  indexes: [{ on: ['slug'], unique: true }],
});

const refusal = (work: Promise<unknown>): Promise<string | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : 'refused',
  );

const rollingBack = (work: (tx: Tx) => Promise<void>): Promise<unknown> =>
  memoryTransactor()
    .run(async (tx) => {
      await work(tx);
      expect.unreachable('the transaction rolls back');
    })
    .catch(() => undefined);

describe('unit · the memory unique index is maintained, not rebuilt', () => {
  test('4,000 single inserts cost linear time: no write rescans every stored row', async () => {
    const repo = memoryRepo(members);
    const timed = async (from: number, count: number): Promise<number> => {
      const started = performance.now();
      for (let i = from; i < from + count; i += 1) {
        await repo.insert({ id: `m${i}`, email: `${i}@x.test`, handle: `h${i}` });
      }
      return performance.now() - started;
    };
    const first = await timed(0, 1_000);
    await timed(1_000, 2_000);
    const last = await timed(3_000, 1_000);
    // A rescan per write makes the last thousand ~7x the first; kept, they cost the same. 3x is
    // headroom for a noisy runner, far under what a rebuild costs.
    expect(last).toBeLessThan(Math.max(first, 20) * 3);
    expect(await refusal(repo.insert({ id: 'dup', email: '3999@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
  });

  test('the first clashing constraint, in declaration order, is the one reported', async () => {
    const repo = memoryRepo(members);
    await repo.insert({ id: 'a', email: 'a@x.test', handle: 'ha' });
    const both = await refusal(repo.insert({ id: 'b', email: 'a@x.test', handle: 'ha' }));
    expect(both).toContain('mui_members_email');
    const handle = await refusal(repo.insert({ id: 'b', email: 'b@x.test', handle: 'ha' }));
    expect(handle).toContain('mui_members_handle');
  });

  test('NULLs are never equal', async () => {
    const repo = memoryRepo(members);
    await repo.insert({ id: 'a', email: 'a@x.test', handle: null });
    await repo.insert({ id: 'b', email: 'b@x.test', handle: null });
    expect((await repo.findMany({})).rows).toHaveLength(2);
  });

  test('an update moves its keys: the old value is free, the new one taken, its own kept', async () => {
    const repo = memoryRepo(members);
    await repo.insert({ id: 'a', email: 'a@x.test', handle: null });
    await repo.update('a', { email: 'a@x.test', handle: 'same' });
    await repo.update('a', { email: 'moved@x.test' });
    await repo.insert({ id: 'b', email: 'a@x.test', handle: null });
    expect(await refusal(repo.insert({ id: 'c', email: 'moved@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
    expect(await refusal(repo.update('b', { email: 'moved@x.test' }))).toContain(
      'mui_members_email',
    );
  });

  test('a rolled-back insert, update and delete leave the index as they found it', async () => {
    const repo = memoryRepo(members);
    await repo.insert({ id: 'kept', email: 'kept@x.test', handle: null });
    await repo.insert({ id: 'gone', email: 'gone@x.test', handle: null });
    await rollingBack(async (tx) => {
      await repo.insert({ id: 'new', email: 'new@x.test', handle: null }, { tx });
      await repo.update('kept', { email: 'elsewhere@x.test' }, { tx });
      await repo.delete('gone', { tx });
    });
    // The rolled-back insert holds nothing; the update's new value is free and its old one taken.
    await repo.insert({ id: 'n1', email: 'new@x.test', handle: null });
    await repo.insert({ id: 'n2', email: 'elsewhere@x.test', handle: null });
    expect(await refusal(repo.insert({ id: 'n3', email: 'kept@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
    // The restored row holds its key again.
    expect(await refusal(repo.insert({ id: 'n4', email: 'gone@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
  });

  test('a delete frees its key; a soft delete keeps it, as a non-partial index does', async () => {
    const people = memoryRepo(members);
    await people.insert({ id: 'a', email: 'a@x.test', handle: null });
    await people.delete('a');
    await people.insert({ id: 'b', email: 'a@x.test', handle: null });
    const repo = memoryRepo(notes);
    await repo.insert({ id: 'n', slug: 'hello', deletedAt: null });
    await repo.delete('n');
    expect(await refusal(repo.insert({ id: 'm', slug: 'hello', deletedAt: null }))).toContain(
      'mui_notes_slug',
    );
    await repo.insert({ id: 'o', slug: 'other', deletedAt: null });
    await repo.deleteWhere({ slug: 'other' });
    expect(await refusal(repo.insert({ id: 'p', slug: 'other', deletedAt: null }))).toContain(
      'mui_notes_slug',
    );
  });

  test('reset returns the index to the seed', async () => {
    const repo = memoryRepo(members, [{ id: 's', email: 'seed@x.test', handle: null }]);
    await repo.insert({ id: 'a', email: 'a@x.test', handle: null });
    repo.reset();
    await repo.insert({ id: 'b', email: 'a@x.test', handle: null });
    expect(await refusal(repo.insert({ id: 'c', email: 'seed@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
  });

  test('a rolled-back updateWhere and deleteWhere restore every key they moved', async () => {
    const repo = memoryRepo(members);
    await repo.insert({ id: 'a', email: 'a@x.test', handle: 'ha' });
    await repo.insert({ id: 'b', email: 'b@x.test', handle: 'hb' });
    await rollingBack(async (tx) => {
      await repo.updateWhere({ id: 'a' }, { handle: 'moved' }, { tx });
      await repo.deleteWhere({ id: 'b' }, { tx });
    });
    expect(await refusal(repo.insert({ id: 'c', email: 'c@x.test', handle: 'ha' }))).toContain(
      'mui_members_handle',
    );
    expect(await refusal(repo.insert({ id: 'd', email: 'b@x.test', handle: null }))).toContain(
      'mui_members_email',
    );
    await repo.insert({ id: 'e', email: 'e@x.test', handle: 'moved' });
  });
});
