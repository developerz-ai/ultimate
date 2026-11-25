// `updateWhereReturning`: `updateWhere`'s write, answering the rows it wrote. Memory driver, the
// recording client for the Postgres statement, and every layer a repository passes through —
// the guards are `updateWhere`'s, so each is proved on this call too, not assumed.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { EntityBulkEvent } from '@ultimat3/core';
import {
  ctxOf,
  frozenClock,
  resetInstrumentation,
  runWithContext,
  subscribe,
  userActor,
} from '@ultimat3/core';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { boolean, text, timestamp, uuid } from './columns';
import { database, memoryDriver } from './database';
import { entity } from './entity';
import type { EntityError } from './errors';
import { invariant, MAX_ASSERTED_ROWS } from './invariants';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { tableFor } from './query';
import { clearRegistry } from './registry';
import type { Repo } from './repo';

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-7000-8000-0000000000a2';
const id = (n: number): string => `00000000-0000-7000-8000-00000000010${n}`;

const tasks = entity('uwr_tasks', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    status: text({ max: 20 }),
    note: text().nullable(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
    deletedAt: timestamp().nullable(),
  },
});

const slugs = entity('uwr_slugs', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    slug: text({ max: 40 }),
    locked: boolean().default(false),
  },
  invariants: (c) => [
    // Two columns, so ONE patch is fine on one row and refused on another.
    invariant(
      'locked_keeps_slug',
      c.satisfies((slug, locked) => locked !== true || slug === 'kept', ['slug', 'locked']),
    ),
  ],
});

const stamp = new Date('2000-01-01T00:00:00Z');
const task = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  orgId: ORG,
  status: 'open',
  note: null,
  updatedAt: stamp,
  deletedAt: null,
  ...over,
});

const caught = async (work: Promise<unknown>): Promise<EntityError | undefined> =>
  work.then(
    () => undefined,
    (error: unknown) => error as EntityError,
  );

afterEach(() => {
  resetInstrumentation();
  setDbClient(undefined);
});
afterAll(() => {
  clearRegistry();
});

/** The method every shipped driver has; its absence is a failure of the test's setup, not a result. */
const updating = <R>(repo: Repo<R>): NonNullable<Repo<R>['updateWhereReturning']> => {
  const write = repo.updateWhereReturning;
  if (write === undefined) expect.unreachable('this repository has no updateWhereReturning');
  return write.bind(repo);
};

const NOW = new Date('2026-03-04T05:06:07.000Z');
const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(
    ctxOf({ actor: userActor({ id: 'm1', orgId: ORG, roles: [] }), clock: frozenClock(NOW) }),
    work,
  );

/** One row past the bound, every one matched by `{ orgId: ORG }`. */
const tooMany = <T>(row: (id: string) => T): T[] =>
  Array.from({ length: MAX_ASSERTED_ROWS + 1 }, (_, n) =>
    row(`00000000-0000-7000-8000-${String(n).padStart(12, '0')}`),
  );

describe('memory driver', () => {
  test('answers the rows it wrote, as stored, and writes only the matching ones', async () => {
    const repo = memoryRepo(tasks, [task(1), task(2, { status: 'done' }), task(3)]);
    const rows = await updating(repo)({ status: 'open' }, { note: 'x' }, { orgId: ORG });

    expect(rows.map((row) => row.id).sort()).toEqual([id(1), id(3)]);
    expect(rows.every((row) => row.note === 'x' && row.status === 'open')).toBe(true);
    expect((await repo.findById(id(2), { orgId: ORG }))?.note).toBeNull();
  });

  test('a filter that matches nothing answers [] and is not X_NOT_FOUND', async () => {
    const repo = memoryRepo(tasks, [task(1, { status: 'done' })]);
    expect(await updating(repo)({ status: 'open' }, { note: 'x' }, { orgId: ORG })).toEqual([]);
  });

  test('"update if still open": the second caller to the same row gets nothing back', async () => {
    const repo = memoryRepo(tasks, [task(1)]);
    const claim = () =>
      updating(repo)({ id: id(1), status: 'open' }, { status: 'claimed' }, { orgId: ORG });
    expect(await claim()).toHaveLength(1);
    expect(await claim()).toEqual([]);
  });

  test("another tenant's rows are unreachable", async () => {
    const repo = memoryRepo(tasks, [task(1, { orgId: OTHER_ORG })]);
    expect(await updating(repo)({ status: 'open' }, { note: 'x' }, { orgId: ORG })).toEqual([]);
    expect((await repo.findById(id(1), { orgId: OTHER_ORG }))?.note).toBeNull();
  });

  test('a soft-deleted row is neither written nor answered', async () => {
    const repo = memoryRepo(tasks, [task(1, { deletedAt: stamp })]);
    expect(await updating(repo)({ status: 'open' }, { note: 'x' }, { orgId: ORG })).toEqual([]);
  });

  test('refuses what updateWhere refuses: no filter, no columns', async () => {
    const repo = memoryRepo(tasks, [task(1)]);
    const unfiltered = await caught(updating(repo)({}, { note: 'x' }, { orgId: ORG }));
    const empty = await caught(updating(repo)({ status: 'open' }, {}, { orgId: ORG }));
    expect(unfiltered).toBeUltimateError('X_WRITE_UNFILTERED');
    expect(empty).toBeUltimateError('X_PATCH_EMPTY');
    // Each names the call the author wrote, not the one it shares its plan with.
    for (const refused of [unfiltered, empty]) {
      expect(String(refused?.cause)).toContain('uwr_tasks.updateWhereReturning()');
    }
  });

  test('one row an invariant refuses refuses the whole write: the row before it does not land', async () => {
    const repo = memoryRepo(slugs, [
      { id: id(1), orgId: ORG, slug: 'a', locked: false },
      { id: id(2), orgId: ORG, slug: 'kept', locked: true },
    ]);
    // The same patch alone is fine on the first row, so only the second can be what refuses it.
    expect(
      await caught(updating(repo)({ orgId: ORG }, { slug: 'moved' }, { orgId: ORG })),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
    const held = (await repo.findMany({ orgId: ORG })).rows.map((row) => row.slug);
    expect(held.sort()).toEqual(['a', 'kept']);
    expect(await updating(repo)({ id: id(1) }, { slug: 'moved' }, { orgId: ORG })).toHaveLength(1);
  });

  test('a rule only the app can judge is bounded as updateWhere is', async () => {
    const many = tooMany((each) => ({ id: each, orgId: ORG, slug: 'a', locked: false }));
    const repo = memoryRepo(slugs, many);
    const patch = { slug: 'b' };
    const counted = await caught(repo.updateWhere({ orgId: ORG }, patch, { orgId: ORG }));
    const returning = await caught(updating(repo)({ orgId: ORG }, patch, { orgId: ORG }));
    expect(counted).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(returning).toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('a result past the bound is refused with nothing written, with no rule to judge', async () => {
    const repo = memoryRepo(
      tasks,
      tooMany((each) => task(1, { id: each })),
    );
    const refused = await caught(updating(repo)({ orgId: ORG }, { note: 'x' }, { orgId: ORG }));
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(refused?.cause)).toContain('.inBatches(1000)');
    const wrote = [{ column: 'note', op: 'eq' as const, value: 'x' }];
    expect(await repo.count({ orgId: ORG, where: wrote })).toBe(0);
    // `updateWhere` answers a count and holds no rows: it has no such bound.
    expect(await repo.updateWhere({ orgId: ORG }, { note: 'x' }, { orgId: ORG })).toBe(
      MAX_ASSERTED_ROWS + 1,
    );
  });
});

describe('the typed handle', () => {
  test('stamps onUpdateNow() as updateWhere does, and reports one bulk event', async () => {
    const bulk: EntityBulkEvent[] = [];
    subscribe('entity.bulk', (event) => void bulk.push(event.payload));
    const db = database({ tasks }, { driver: memoryDriver() });
    const rows = await asMember(async () => {
      await db.tasks.insertAll([
        { id: id(1), orgId: ORG, status: 'open', updatedAt: stamp },
        { id: id(2), orgId: ORG, status: 'open', updatedAt: stamp },
      ]);
      return db.tasks.updateWhereReturning({ orgId: ORG }, { status: 'closed' });
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.status, row.updatedAt])).toEqual([
      ['closed', NOW],
      ['closed', NOW],
    ]);
    expect(bulk).toEqual([{ entity: 'uwr_tasks', op: 'update', rows: 2 }]);
  });

  test('a patch cannot hand rows to another tenant, even when the filter matches none', async () => {
    const db = database({ tasks }, { driver: memoryDriver() });
    expect(
      await caught(
        asMember(() => db.tasks.updateWhereReturning({ status: 'open' }, { orgId: OTHER_ORG })),
      ),
    ).toBeUltimateError('X_TENANCY_ACTOR_MISMATCH');
  });

  test('a hand-written repository without it is refused before anything is written', async () => {
    const { updateWhereReturning: _dropped, ...bare } = memoryRepo(tasks, [task(1), task(2)]);
    let writes = 0;
    const counting: Repo<typeof tasks.$row> = {
      ...bare,
      updateWhere: async (filter, patch, options) => {
        writes += 1;
        return bare.updateWhere(filter, patch, options);
      },
    };
    const refused = await caught(
      tableFor(tasks, counting).updateWhereReturning(
        { status: 'open' },
        { note: 'x' },
        { orgId: ORG },
      ),
    );
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(refused?.fix).toContain('implement updateWhereReturning');
    expect(writes).toBe(0);
    expect((await bare.findById(id(1), { orgId: ORG }))?.note).toBeNull();
  });
});

describe('postgres statement', () => {
  const physical = (over: Record<string, unknown> = {}) => ({
    id: id(1),
    org_id: ORG,
    status: 'closed',
    note: null,
    updated_at: stamp,
    deleted_at: null,
    ...over,
  });
  let client: RecordingClient;
  const use = () => {
    client = recordingClient();
    setDbClient(client);
  };

  test('naming the primary key is ONE update … returning * — no count before it, no lock, no select', async () => {
    use();
    client.on('update', { rows: [physical()] });
    const rows = await updating(postgresRepo(tasks))(
      { id: id(1), status: 'open' },
      { status: 'closed' },
      { orgId: ORG },
    );

    expect(rows.map((row) => row.id)).toEqual([id(1)]);
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toStartWith('update "uwr_tasks" set');
    expect(client.texts[0]).toEndWith('returning *');
    expect(client.texts[0]).not.toContain('for update');
  });

  test('a filter that could match many is counted first; past the bound no update is sent', async () => {
    use();
    const claim = () =>
      updating(postgresRepo(tasks))({ status: 'open' }, { status: 'closed' }, { orgId: ORG });
    client.on('count(*)', { rows: [{ count: String(MAX_ASSERTED_ROWS + 1) }] });
    const refused = await caught(claim());
    expect(refused).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(String(refused?.cause)).toContain('.inBatches(1000)');
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toContain('count(*)');

    use();
    client.on('count(*)', { rows: [{ count: String(MAX_ASSERTED_ROWS) }] });
    client.on('update', { rows: [physical()] });
    expect(await claim()).toHaveLength(1);
    expect(client.texts.map((each) => each.split(' ')[0])).toEqual(['select', 'update']);
  });

  test('carries the tenant, the soft-delete clause and the bound updated_at stamp, like updateWhere', async () => {
    use();
    const table = tableFor(tasks, postgresRepo(tasks));
    const filter = { id: id(1), status: 'open' };
    client.on('update', { rows: [], affected: 0 });
    await asMember(() => table.updateWhere(filter, { status: 'closed' }));
    const counted = client.statements.at(-1);
    expect(await asMember(() => table.updateWhereReturning(filter, { status: 'closed' }))).toEqual(
      [],
    );
    const returning = client.statements.at(-1);

    expect(returning?.text).toBe(`${counted?.text} returning *`);
    expect(returning?.values).toEqual(counted?.values ?? []);
    expect(returning?.text).toContain('"org_id" = $');
    expect(returning?.text).toContain('"deleted_at" is null');
    const placed = /set .*"updated_at" = \$(\d+).* where/.exec(returning?.text ?? '')?.[1];
    expect(returning?.values[Number(placed) - 1]).toEqual(NOW);
  });

  test('an entity with a rule only the app can judge reads and judges the rows it wrote', async () => {
    use();
    client.on('count(*)', { rows: [{ count: 1 }] });
    client.on('update', { rows: [{ id: id(1), org_id: ORG, slug: 'ok', locked: false }] });
    const rows = await updating(postgresRepo(slugs))(
      { orgId: ORG },
      { slug: 'ok' },
      { orgId: ORG },
    );
    expect(rows).toHaveLength(1);

    client.on('update', { rows: [{ id: id(1), org_id: ORG, slug: 'x', locked: true }] });
    expect(
      await caught(updating(postgresRepo(slugs))({ orgId: ORG }, { slug: 'x' }, { orgId: ORG })),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(client.texts.at(-1)).toBe('ROLLBACK');
  });
});
