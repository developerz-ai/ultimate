// Every wrapper a repository passes through, on the writes sweep 5a added: `updateMany`, the
// count-only `insertAll`/`upsertAll`, `copyAll` and the chain's `updateAll`/`deleteAll`. Each must
// mean through a seam exactly what its counterpart means — sealed, refused, mirrored, reported.

import { afterEach, describe, expect, test } from 'bun:test';
import type { EntityBulkEvent, EntityRowEvent } from '@ultimat3/core';
import {
  ctxOf,
  isSealed,
  resetInstrumentation,
  runWithContext,
  subscribe,
  userActor,
} from '@ultimat3/core';
import { integer, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';
import { sealedRepo } from './sealed-repo';
import type { SearchIndex } from './search-index';
import { installSearchIndex } from './search-index-installed';
import { memorySearchIndex } from './search-index-memory';
import { updateManyPlan } from './update-many';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const idAt = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
  resetInstrumentation();
  clearRegistry();
});

const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'm1', orgId: ORG, roles: [] }) }), work);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
  return 'resolved';
};

const notesEntity = () =>
  entity('qww_notes', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      title: text().searchable(),
      reads: integer().default(0),
      updatedAt: timestamp().defaultNow().onUpdateNow(),
    },
  });

const rowsOf = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, at) => ({
    id: idAt(from + at),
    orgId: ORG,
    title: `zebra ${from + at}`,
  }));

describe('sealedRepo', () => {
  const secrets = entity('qww_secrets', {
    columns: { id: uuid().primaryKey(), label: text(), token: text().sealed() },
  });

  test('every count-only and bulk write hands the driver ciphertext', async () => {
    const seen: unknown[] = [];
    const recording = {
      insertAllCount: async (rows: readonly unknown[]) => seen.push(...rows),
      upsertAllCount: async (rows: readonly unknown[]) => seen.push(...rows),
      copyAll: async (rows: readonly unknown[]) => seen.push(...rows),
      updateMany: async (rows: readonly { patch: unknown }[]) =>
        seen.push(...rows.map((row) => row.patch)),
    } as unknown as Repo<Record<string, unknown>>;
    const sealing = sealedRepo(secrets, recording);
    const row = { id: idAt(1), label: 'l', token: 'hunter2' };
    await sealing.insertAllCount?.([row]);
    await sealing.upsertAllCount?.([row], { onConflict: ['id'] });
    await sealing.copyAll?.([row]);
    await sealing.updateMany?.([{ id: idAt(1), patch: { token: 'next' } }]);
    expect(seen).toHaveLength(4);
    for (const reached of seen) {
      expect(isSealed((reached as Record<string, unknown>)['token'])).toBe(true);
    }
    expect(row.token).toBe('hunter2');
  });

  test('a member the inner repository lacks stays absent, so the fallback still sees it', () => {
    const sealing = sealedRepo(secrets, {} as Repo<Record<string, unknown>>);
    expect(sealing.copyAll).toBeUndefined();
    expect(sealing.updateMany).toBeUndefined();
  });

  test('a chain filters as a read does: a null test passes, an opaque value is refused', async () => {
    const db = database({ secrets }, { driver: memoryDriver() });
    await db.secrets.insert({ id: idAt(1), label: 'l', token: 'hunter2' });
    expect(await db.secrets.andWhere('token', 'is-not-null').updateAll({ label: 'm' })).toBe(1);
    const named = db.secrets.where({ token: 'hunter2' } as never);
    expect(await codeOf(() => named.updateAll({ label: 'x' }))).toBe('X_ENTITY_SEALED_PREDICATE');
    expect(await codeOf(() => named.deleteAll())).toBe('X_ENTITY_SEALED_PREDICATE');
    expect(await codeOf(() => db.secrets.deleteWhere({ token: 'hunter2' } as never))).toBe(
      'X_ENTITY_SEALED_PREDICATE',
    );
  });
});

describe('appendOnlyRepo and readOnlyRepo', () => {
  test('append-only: updateMany and an updating count-only upsert are refused; appends are not', async () => {
    const ledger = entity('qww_ledger', {
      columns: { id: uuid().primaryKey(), amount: integer() },
      appendOnly: true,
    });
    const db = database({ ledger }, { driver: memoryDriver() });
    expect(await db.ledger.insertAll([{ id: idAt(1), amount: 1 }], { returning: false })).toBe(1);
    expect(await db.ledger.copyAll([{ id: idAt(2), amount: 2 }])).toBe(1);
    expect(await codeOf(() => db.ledger.updateMany([{ id: idAt(1), patch: { amount: 5 } }]))).toBe(
      'X_ENTITY_APPEND_ONLY',
    );
    expect(
      await codeOf(() =>
        db.ledger.upsertAll([{ id: idAt(1), amount: 9 }], { onConflict: ['id'], returning: false }),
      ),
    ).toBe('X_ENTITY_APPEND_ONLY');
    expect(
      await db.ledger.upsertAll([{ id: idAt(3), amount: 3 }], {
        onConflict: ['id'],
        onMatch: 'nothing',
        returning: false,
      }),
    ).toBe(1);
    expect(await codeOf(() => db.ledger.where({ amount: 1 }).deleteAll())).toBe(
      'X_ENTITY_APPEND_ONLY',
    );
  });

  test('read-only: every new write is refused before it reaches the store', async () => {
    const legacy = entity('qww_legacy', {
      columns: { id: uuid().primaryKey(), amount: integer() },
      readOnly: 'written by the legacy importer',
    });
    const db = database({ legacy }, { driver: memoryDriver() });
    const row = { id: idAt(1), amount: 1 };
    for (const write of [
      () => db.legacy.insertAll([row], { returning: false }),
      () => db.legacy.upsertAll([row], { onConflict: ['id'], returning: false }),
      () => db.legacy.copyAll([row]),
      () => db.legacy.updateMany([{ id: idAt(1), patch: { amount: 2 } }]),
      () => db.legacy.where({ amount: 1 }).updateAll({ amount: 2 }),
    ]) {
      expect(await codeOf(write)).toBe('X_ENTITY_READ_ONLY');
    }
  });
});

describe('the search mirror', () => {
  const installed = (): SearchIndex => {
    const index = memorySearchIndex();
    release = installSearchIndex(index);
    return index;
  };
  const hits = async (index: SearchIndex, term: string) =>
    (await index.query({ entity: 'qww_notes', tenant: ORG, term })).map((hit) => hit.id).sort();

  test('count-only inserts and copyAll still reach an installed index', async () => {
    const index = installed();
    const db = database({ notes: notesEntity() }, { driver: memoryDriver() });
    await asMember(async () => {
      expect(await db.notes.insertAll(rowsOf(1, 2), { returning: false })).toBe(2);
      expect(await db.notes.copyAll(rowsOf(3, 3))).toBe(1);
      expect(
        await db.notes.upsertAll(rowsOf(4, 4), {
          onConflict: ['id'],
          onMatch: 'nothing',
          returning: false,
        }),
      ).toBe(1);
    });
    await settle();
    expect(await hits(index, 'zebra')).toEqual([idAt(1), idAt(2), idAt(3), idAt(4)]);
  });

  test('updateMany and a chain updateAll/deleteAll move the index with the rows', async () => {
    const index = installed();
    const db = database({ notes: notesEntity() }, { driver: memoryDriver() });
    await asMember(async () => {
      await db.notes.insertAll(rowsOf(1, 3));
      expect(
        await db.notes.updateMany([
          { id: idAt(1), patch: { title: 'okapi one' } },
          { id: idAt(2), patch: { title: 'okapi two' } },
        ]),
      ).toBe(2);
      expect(await db.notes.andWhere('id', 'in', [idAt(3)]).updateAll({ title: 'okapi 3' })).toBe(
        1,
      );
    });
    await settle();
    expect(await hits(index, 'okapi')).toEqual([idAt(1), idAt(2), idAt(3)]);
    expect(await hits(index, 'zebra')).toEqual([]);
    await asMember(() => db.notes.andWhere('id', 'in', [idAt(1), idAt(2)]).deleteAll());
    await settle();
    expect(await hits(index, 'okapi')).toEqual([idAt(3)]);
  });
});

describe('the row observer', () => {
  test('a count-only insert still reports each stored row while entity.row is heard', async () => {
    const seen: EntityRowEvent[] = [];
    subscribe('entity.row', (event) => void seen.push(event.payload));
    const db = database({ notes: notesEntity() }, { driver: memoryDriver() });
    await asMember(async () => {
      expect(await db.notes.insertAll(rowsOf(1, 2), { returning: false })).toBe(2);
      expect(await db.notes.copyAll(rowsOf(3, 3))).toBe(1);
    });
    expect(seen.map((change) => [change.op, change.after?.['id']])).toEqual([
      ['insert', idAt(1)],
      ['insert', idAt(2)],
      ['insert', idAt(3)],
    ]);
  });

  test('updateMany and the chain writes are entity.bulk, as updateWhere is', async () => {
    const bulk: EntityBulkEvent[] = [];
    subscribe('entity.bulk', (event) => void bulk.push(event.payload));
    const db = database({ notes: notesEntity() }, { driver: memoryDriver() });
    await asMember(async () => {
      await db.notes.insertAll(rowsOf(1, 3));
      await db.notes.updateMany([
        { id: idAt(1), patch: { reads: 1 } },
        { id: idAt(2), patch: { reads: 2 } },
      ]);
      await db.notes.where({ reads: 0 }).updateAll({ reads: 7 });
      await db.notes.where({ reads: 7 }).deleteAll();
    });
    expect(bulk.map((event) => [event.op, event.rows])).toEqual([
      ['update', 2],
      ['update', 1],
      ['delete', 1],
    ]);
  });
});

describe('a hand-written repository without the optional members', () => {
  test('the typed handle falls back to the counterpart every repository has', async () => {
    const notes = notesEntity();
    const inner = memoryDriver().repo(notes);
    const { insertAllCount: _a, upsertAllCount: _b, copyAll: _c, updateMany: _d, ...bare } = inner;
    const table = tableFor(notes, bare as Repo<typeof inner extends Repo<infer R> ? R : never>);
    await asMember(async () => {
      expect(await table.insertAll(rowsOf(1, 2), { returning: false })).toBe(2);
      expect(await table.copyAll(rowsOf(3, 3))).toBe(1);
      expect(
        await table.upsertAll(rowsOf(4, 4), {
          onConflict: ['id'],
          onMatch: 'nothing',
          returning: false,
        }),
      ).toBe(1);
      expect(
        await table.updateMany([
          { id: idAt(1), patch: { reads: 4 } },
          { id: idAt(9), patch: { reads: 4 } },
        ]),
      ).toBe(1);
      expect(await table.where({ reads: 4 }).count()).toBe(1);
    });
  });
});

describe('updateMany and copyAll refuse alike on every repository', () => {
  /** The memory repository with the four optional members taken off: a hand-written one. */
  const bareTable = () => {
    const notes = notesEntity();
    const inner = memoryDriver().repo(notes);
    const { insertAllCount: _a, upsertAllCount: _b, copyAll: _c, updateMany: _d, ...bare } = inner;
    return { notes, bare: tableFor(notes, bare as typeof inner) };
  };

  test('a nullish id is X_WRITE_UNFILTERED — in the shared plan, on memory and on the fallback', async () => {
    const { notes, bare } = bareTable();
    const db = database({ notes }, { driver: memoryDriver() });
    for (const id of [undefined, null]) {
      const rows = [{ id: id as unknown as string, patch: { reads: 1 } }];
      expect(await codeOf(async () => updateManyPlan(notes, rows, { orgId: ORG }))).toBe(
        'X_WRITE_UNFILTERED',
      );
      expect(await codeOf(() => asMember(() => db.notes.updateMany(rows)))).toBe(
        'X_WRITE_UNFILTERED',
      );
      expect(await codeOf(() => asMember(() => bare.updateMany(rows)))).toBe('X_WRITE_UNFILTERED');
    }
  });

  test('the fallback refuses a repeated id, as the drivers do, and writes nothing', async () => {
    const { bare } = bareTable();
    await asMember(async () => {
      await bare.insertAll(rowsOf(1, 2));
      const twice = [
        { id: idAt(1), patch: { reads: 1 } },
        { id: idAt(1), patch: { reads: 2 } },
      ];
      expect(await codeOf(() => bare.updateMany(twice))).toBe('X_INVARIANT_VIOLATED');
      expect(await bare.count()).toBe(2);
      expect(await bare.where({ reads: 0 }).count()).toBe(2);
    });
  });
});
