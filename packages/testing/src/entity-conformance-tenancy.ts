// Entity conformance · TENANCY on writes: a row may name the actor's tenant or none, a batch is
// refused whole, an upsert collision cannot land in another tenant, and a reference into another
// tenant is refused like a missing parent. Each refusal is asserted through the store's contents:
// nothing written. Lifted from `entity/src/{write-tenancy,same-tenant}-parity.test.ts`.

import { expect } from 'bun:test';
import { ctxOf, isUltimateError, runWithContext, serviceActor } from '@ultimat3/core';
import type { Database, Repo } from '@ultimat3/entity';
import { CROSS_TENANT_SCOPE, crossTenant, entity, text, uuid } from '@ultimat3/entity';
import { remember } from './entity-conformance-entities';
import { checkOver, codeOf, idAt, inOrg } from './entity-conformance-support';
import type { EntityDriverCheck } from './entity-driver-conformance';

const posts = remember(
  entity('ec_t_posts', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid().tenant(),
      slug: text({ max: 40 }),
      title: text({ max: 40 }),
    },
    indexes: [
      { on: ['orgId', 'slug'], unique: true },
      { on: ['slug'], unique: true },
    ],
  }),
);
type Post = typeof posts.$row;

const orgs = remember(entity('ec_t_orgs', { columns: { id: uuid().primaryKey() } }));

const threads = remember(
  entity('ec_t_threads', {
    columns: {
      id: uuid().primaryKey(),
      orgId: uuid()
        .references(() => orgs.id)
        .tenant(),
      title: text({ max: 40 }),
    },
  }),
);

const commentPk = uuid().primaryKey();
const comments = remember(
  entity('ec_t_comments', {
    columns: {
      id: commentPk,
      orgId: uuid().tenant(),
      threadId: uuid().references(() => threads.id),
      parentId: uuid()
        .nullable()
        .references(() => commentPk),
      sharedThreadId: uuid()
        .nullable()
        .references(() => threads.id, { crossTenant: 'a thread another org shared with this one' }),
    },
    indexes: [{ on: ['orgId', 'id'], unique: true }],
  }),
);

const ORG = idAt('a1');
const OTHER_ORG = idAt('a2');
const MINE = idAt('11');
const THEIRS = idAt('22');
const MISMATCH = 'X_TENANCY_ACTOR_MISMATCH';

const post = (over: Partial<Post> = {}): Post => ({
  id: MINE,
  orgId: ORG,
  slug: 'ours',
  title: 'ours',
  ...over,
});

/** Seeded outside any request, as a script would, and counted there: the table's own answer. */
const seeded = async (repo: Repo<Post>): Promise<Repo<Post>> => {
  await repo.insertAll([post(), post({ id: THEIRS, orgId: OTHER_ORG, slug: 'theirs' })]);
  return repo;
};
const held = async (repo: Repo<Post>): Promise<readonly string[]> =>
  [
    ...(await repo.findMany({ orgId: ORG })).rows,
    ...(await repo.findMany({ orgId: OTHER_ORG })).rows,
  ]
    .map((row) => `${row.slug}:${row.title}`)
    .sort();
const UNTOUCHED = ['ours:ours', 'theirs:ours'];

const asReconciler = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(
    ctxOf({ actor: serviceActor({ id: idAt('91'), orgId: ORG, scopes: [CROSS_TENANT_SCOPE] }) }),
    () => crossTenant('nightly reconciliation writes into every org', work),
  );

/** One refused write: the code, and a store holding exactly what it held before. */
const refusedWrite = (
  name: string,
  code: string,
  write: (repo: Repo<Post>) => Promise<unknown>,
  needs: readonly ['upsert'] | [] = [],
) =>
  checkOver(
    { posts },
    name,
    async (_db, { driver }) => {
      const repo = await seeded(driver.repo(posts));
      expect(await inOrg(ORG, () => codeOf(() => write(repo)))).toBe(code);
      expect(await held(repo)).toEqual(UNTOUCHED);
    },
    needs,
  );

const writeTenancy: readonly EntityDriverCheck[] = [
  refusedWrite(
    'an insert into another tenant is refused, and nothing is written',
    MISMATCH,
    (repo) => repo.insert(post({ id: idAt('33'), orgId: OTHER_ORG, slug: 'stolen' })),
  ),
  refusedWrite('one bad row refuses the whole batch before any of it lands', MISMATCH, (repo) =>
    repo.insertAll([
      post({ id: idAt('34'), slug: 'a' }),
      post({ id: idAt('35'), orgId: OTHER_ORG, slug: 'b' }),
    ]),
  ),
  refusedWrite(
    'an upsert naming another tenant is refused even where it would be skipped',
    MISMATCH,
    (repo) =>
      repo.upsertAll([post({ id: idAt('36'), orgId: OTHER_ORG, slug: 'theirs' })], {
        onConflict: ['slug'],
        onMatch: 'nothing',
      }),
    ['upsert'],
  ),
  refusedWrite('a patch handing a row to another tenant is refused by id', MISMATCH, (repo) =>
    repo.update(MINE, { orgId: OTHER_ORG }),
  ),
  refusedWrite('a patch handing rows to another tenant is refused by filter', MISMATCH, (repo) =>
    repo.updateWhere({ slug: 'ours' }, { orgId: OTHER_ORG }),
  ),
  refusedWrite('the patch is refused even when the filter matches no row', MISMATCH, (repo) =>
    repo.updateWhere({ slug: 'no-such-slug' }, { orgId: OTHER_ORG }),
  ),
  refusedWrite(
    'an upsert target without the tenant column is refused under onMatch: update',
    'X_TENANCY_UNSCOPED',
    (repo) => repo.upsertAll([post({ id: idAt('41'), slug: 'ours' })], { onConflict: ['slug'] }),
    ['upsert'],
  ),
  refusedWrite(
    'with the tenant in the target, another tenant’s row is still unreachable',
    MISMATCH,
    (repo) =>
      repo.upsertAll([post({ id: THEIRS, orgId: OTHER_ORG, slug: 'theirs', title: 'taken' })], {
        onConflict: ['orgId', 'slug'],
      }),
    ['upsert'],
  ),
  checkOver(
    { posts },
    'naming the actor’s own tenant, or none, writes',
    async (_db, { driver }) => {
      const repo = await seeded(driver.repo(posts));
      await inOrg(ORG, () => repo.insert(post({ id: idAt('37'), slug: 'fresh' })));
      await inOrg(ORG, () => repo.update(MINE, { title: 'renamed' } as Partial<Post>));
      expect(await held(repo)).toEqual(['fresh:ours', 'ours:renamed', 'theirs:ours']);
    },
  ),
  checkOver(
    { posts },
    'an upsert keyed on tenant and slug overwrites the actor’s own row',
    async (_db, { driver }) => {
      const repo = await seeded(driver.repo(posts));
      const renamed = post({ title: 'renamed' });
      await inOrg(ORG, () => repo.upsertAll([renamed], { onConflict: ['orgId', 'slug'] }));
      expect(await held(repo)).toEqual(['ours:renamed', 'theirs:ours']);
    },
    ['upsert'],
  ),
  checkOver(
    { posts },
    'an actor with no tenant writes nothing tenant-scoped',
    async (_db, { driver }) => {
      const repo = await seeded(driver.repo(posts));
      const anon = () => repo.insert(post({ id: idAt('38'), slug: 'anon' }));
      expect(await runWithContext(ctxOf(), () => codeOf(anon))).toBe(
        'X_TENANCY_ACTOR_ORG_REQUIRED',
      );
      expect(await held(repo)).toEqual(UNTOUCHED);
    },
  ),
  checkOver(
    { posts },
    'outside a request a seed writes the tenant it names; crossTenant too',
    async (_db, { driver }) => {
      const repo = await seeded(driver.repo(posts));
      await repo.insert(post({ id: idAt('39'), orgId: OTHER_ORG, slug: 'seeded' }));
      await asReconciler(() =>
        repo.insert(post({ id: idAt('40'), orgId: OTHER_ORG, slug: 'swept' })),
      );
      expect(await held(repo)).toEqual(['ours:ours', 'seeded:ours', 'swept:ours', 'theirs:ours']);
    },
  ),
];

const VIOLATION = 'X_DB_FOREIGN_KEY_VIOLATION';
const [THREAD_A, THREAD_B, MISSING] = [idAt('1a'), idAt('1b'), idAt('ff')];
const THREAD_C = idAt('1c');
const SET = { orgs, threads, comments };
const comment = (suffix: string, over: Record<string, unknown> = {}) =>
  ({ id: idAt(suffix), orgId: ORG, threadId: THREAD_A, ...over }) as never;

const seedThreads = async (db: Database<typeof SET>): Promise<void> => {
  await db.orgs.insertAll([{ id: ORG }, { id: OTHER_ORG }]);
  await db.threads.insert({ id: THREAD_A, orgId: ORG, title: 'a' });
  await db.threads.insert({ id: THREAD_B, orgId: OTHER_ORG, title: 'b' });
};

const sameTenant: readonly EntityDriverCheck[] = [
  checkOver(SET, 'a reference into another tenant is refused by every write', async (db) => {
    await seedThreads(db);
    expect(await codeOf(() => db.comments.insert(comment('21', { threadId: THREAD_B })))).toBe(
      VIOLATION,
    );
    expect(
      await codeOf(() =>
        db.comments.insertAll([comment('22'), comment('23', { threadId: THREAD_B })]),
      ),
    ).toBe(VIOLATION);
    const nullable = comment('25', { parentId: idAt('31'), threadId: THREAD_B });
    expect(await codeOf(() => db.comments.insert(nullable))).toBe(VIOLATION);
    await db.comments.insert(comment('41'));
    const move = () => db.comments.update(idAt('41'), { threadId: THREAD_B }, { orgId: ORG });
    expect(await codeOf(move)).toBe(VIOLATION);
    await db.comments.insert(comment('51', { orgId: OTHER_ORG, threadId: THREAD_B }));
    expect(await codeOf(() => db.comments.insert(comment('52', { parentId: idAt('51') })))).toBe(
      VIOLATION,
    );
    const kept = await db.comments.where({ orgId: ORG }).all();
    expect(kept.map((row) => [row.id, row.threadId])).toEqual([[idAt('41'), THREAD_A]]);
  }),
  checkOver(
    SET,
    'an upsert referencing another tenant is refused',
    async (db) => {
      await seedThreads(db);
      const upsert = () =>
        db.comments.upsertAll([comment('24', { threadId: THREAD_B })], {
          onConflict: ['orgId', 'id'],
        });
      expect(await codeOf(upsert)).toBe(VIOLATION);
    },
    ['upsert'],
  ),
  checkOver(
    SET,
    'the same tenant, a null key, a declared cross-tenant edge and a forward self-reference write',
    async (db) => {
      await seedThreads(db);
      await db.comments.insert(comment('61'));
      await db.comments.insert(comment('62', { parentId: null }));
      await db.comments.insert(comment('63', { sharedThreadId: THREAD_B }));
      await db.comments.insertAll([comment('64', { parentId: idAt('65') }), comment('65')]);
      expect(await db.comments.where({ orgId: ORG }).count()).toBe(5);
    },
  ),
  checkOver(
    SET,
    'a missing parent is refused exactly as a foreign one, or accepted by a store with no keys',
    async (db, { foreignKeys }) => {
      await seedThreads(db);
      const absent: unknown = await db.comments
        .insert(comment('72', { threadId: MISSING }))
        .catch((error: unknown) => error);
      const foreign: unknown = await db.comments
        .insert(comment('73', { threadId: THREAD_B }))
        .catch((error: unknown) => error);
      if (!isUltimateError(foreign))
        return expect.unreachable('a foreign reference is always refused');
      if (!foreignKeys) {
        expect(isUltimateError(absent)).toBe(false);
        return;
      }
      if (!isUltimateError(absent))
        return expect.unreachable('a store with foreign keys refuses a missing parent');
      // No existence oracle: absent and foreign read the same.
      expect([absent.code, absent.fix, absent.meta?.['constraint']]).toEqual([
        foreign.code,
        foreign.fix,
        foreign.meta?.['constraint'],
      ]);
    },
  ),
];

/** The many-row writes (`copyAll`, the count-only insert, `updateMany`, a chain write) refuse alike. */
const sameTenantBulk: readonly EntityDriverCheck[] = [
  checkOver(
    SET,
    'copyAll and insertAll({ returning: false }) refuse a reference into another tenant whole',
    async (db) => {
      await seedThreads(db);
      const batch = [comment('81'), comment('82', { threadId: THREAD_B })];
      expect(await codeOf(() => db.comments.copyAll(batch))).toBe(VIOLATION);
      expect(await codeOf(() => db.comments.insertAll(batch, { returning: false }))).toBe(
        VIOLATION,
      );
      expect(await db.comments.where({ orgId: ORG }).count()).toBe(0);
      expect(await db.comments.copyAll([comment('83')])).toBe(1);
    },
  ),
  checkOver(
    SET,
    'updateMany and a chain updateAll refuse moving a row onto another tenant’s parent',
    async (db) => {
      await seedThreads(db);
      await db.threads.insert({ id: THREAD_C, orgId: ORG, title: 'c' });
      await db.comments.insertAll([comment('91'), comment('92')]);
      // The first patch is legal: a batch that wrote row by row would move it before refusing.
      const many = () =>
        db.comments.updateMany([
          { id: idAt('91'), patch: { threadId: THREAD_C } },
          { id: idAt('92'), patch: { threadId: THREAD_B } },
        ]);
      // In the actor's own org: unscoped, these are `X_TENANCY_UNSCOPED` before any reference.
      expect(await inOrg(ORG, () => codeOf(many))).toBe(VIOLATION);
      const chain = () =>
        db.comments.where({ orgId: ORG }).updateAll({ threadId: THREAD_B } as never);
      expect(await inOrg(ORG, () => codeOf(chain))).toBe(VIOLATION);
      const kept = await db.comments.where({ orgId: ORG }).orderBy('id').all();
      expect(kept.map((row) => row.threadId)).toEqual([THREAD_A, THREAD_A]);
    },
  ),
];

export const TENANCY_CHECKS: readonly EntityDriverCheck[] = [
  ...writeTenancy,
  ...sameTenant,
  ...sameTenantBulk,
];
