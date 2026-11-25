// `updateWhereReturning`: `updateWhere`'s write, answering the rows it wrote. Memory driver, the
// recording client for the Postgres statement, and every layer a repository passes through —
// the guards are `updateWhere`'s, so each is proved on this call too, not assumed.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { EntityBulkEvent } from '@ultimat3/core';
import { ctxOf, resetInstrumentation, runWithContext, subscribe, userActor } from '@ultimat3/core';
import { type RecordingClient, recordingClient, setDbClient } from '@ultimat3/db';
import { text, timestamp, uuid } from './columns';
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
  },
  invariants: (c) => [
    invariant(
      'slug_shape',
      c.slug.matches((v: string) => /^[a-z-]+$/.test(v)),
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

const asMember = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'm1', orgId: ORG, roles: [] }) }), work);

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
    expect(await caught(updating(repo)({}, { note: 'x' }, { orgId: ORG }))).toBeUltimateError(
      'X_WRITE_UNFILTERED',
    );
    expect(await caught(updating(repo)({ status: 'open' }, {}, { orgId: ORG }))).toBeUltimateError(
      'X_PATCH_EMPTY',
    );
  });

  test('an invariant refuses the whole write: no row lands', async () => {
    const repo = memoryRepo(slugs, [
      { id: id(1), orgId: ORG, slug: 'a' },
      { id: id(2), orgId: ORG, slug: 'b' },
    ]);
    expect(
      await caught(updating(repo)({ orgId: ORG }, { slug: 'Not A Slug' }, { orgId: ORG })),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect((await repo.findMany({ orgId: ORG })).rows.map((row) => row.slug)).toEqual(['a', 'b']);
  });

  test('a rule only the app can judge is bounded as updateWhere is', async () => {
    const many = Array.from({ length: MAX_ASSERTED_ROWS + 1 }, (_, n) => ({
      id: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      orgId: ORG,
      slug: 'a',
    }));
    const repo = memoryRepo(slugs, many);
    const patch = { slug: 'b' };
    const counted = await caught(repo.updateWhere({ orgId: ORG }, patch, { orgId: ORG }));
    const returning = await caught(updating(repo)({ orgId: ORG }, patch, { orgId: ORG }));
    expect(counted).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(returning).toBeUltimateError('X_INVARIANT_VIOLATED');
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
    expect(rows.every((row) => row.status === 'closed' && row.updatedAt > stamp)).toBe(true);
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

  test('a hand-written repository without it answers from updateWhere, and says so when it cannot', async () => {
    const { updateWhereReturning: _dropped, ...bare } = memoryRepo(tasks, [task(1), task(2)]);
    const rows = await tableFor(tasks, bare).updateWhereReturning(
      { status: 'open' },
      { note: 'x' },
      { orgId: ORG },
    );
    expect(rows.map((row) => row.note)).toEqual(['x', 'x']);

    // A repository that wrote rows and named none has nothing to hand back: refused, not guessed.
    const silent: Repo<typeof tasks.$row> = { ...bare, updateWhere: async () => 3 };
    expect(
      await caught(
        tableFor(tasks, silent).updateWhereReturning(
          { status: 'open' },
          { note: 'x' },
          { orgId: ORG },
        ),
      ),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
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

  test('is ONE update … returning * — no count before it, no lock, no select', async () => {
    use();
    client.on('update', { rows: [physical()] });
    const rows = await updating(postgresRepo(tasks))(
      { status: 'open' },
      { status: 'closed' },
      { orgId: ORG },
    );

    expect(rows.map((row) => row.id)).toEqual([id(1)]);
    expect(client.texts).toHaveLength(1);
    expect(client.texts[0]).toStartWith('update "uwr_tasks" set');
    expect(client.texts[0]).toEndWith('returning *');
    expect(client.texts[0]).not.toContain('for update');
  });

  test('carries the tenant, the soft-delete clause and the updated_at stamp, like updateWhere', async () => {
    use();
    client.on('update', { rows: [] });
    const repo = postgresRepo(tasks);
    await repo.updateWhere({ status: 'open' }, { status: 'closed' }, { orgId: ORG });
    const counted = client.texts.at(-1) ?? '';
    client.on('update', { rows: [] });
    expect(await updating(repo)({ status: 'open' }, { status: 'closed' }, { orgId: ORG })).toEqual(
      [],
    );
    const returning = client.texts.at(-1) ?? '';

    expect(returning).toBe(`${counted} returning *`);
    expect(returning).toContain('"org_id" = $');
    expect(returning).toContain('"deleted_at" is null');
  });

  test('an entity with a rule only the app can judge reads and judges the rows it wrote', async () => {
    use();
    client.on('count(*)', { rows: [{ count: 1 }] });
    client.on('update', { rows: [{ id: id(1), org_id: ORG, slug: 'ok' }] });
    const rows = await updating(postgresRepo(slugs))(
      { orgId: ORG },
      { slug: 'ok' },
      { orgId: ORG },
    );
    expect(rows).toHaveLength(1);

    client.on('update', { rows: [{ id: id(1), org_id: ORG, slug: 'Not A Slug' }] });
    expect(
      await caught(updating(postgresRepo(slugs))({ orgId: ORG }, { slug: 'x' }, { orgId: ORG })),
    ).toBeUltimateError('X_INVARIANT_VIOLATED');
    expect(client.texts.at(-1)).toBe('ROLLBACK');
  });
});
