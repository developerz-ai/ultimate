// The two drivers of a tenant-scoped WRITE, side by side. A row carries its tenant as a value, so
// no read plan bounds it — `insert` builds none at all — and the guard that refuses one is the one
// thing both drivers have to say identically. Memory stores nothing and Postgres sends nothing:
// each is that driver's spelling of "refused before it happened".

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  createContext,
  isUltimateError,
  runWithContext,
  serviceActor,
  userActor,
} from '@ultimat3/core';
import { createRecordingClient, type RecordingClient, setDbClient } from '@ultimat3/db';
import { text, uuid } from './columns';
import { CROSS_TENANT_SCOPE, crossTenant } from './cross-tenant';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { clearRegistry } from './registry';

const posts = entity('write_parity_posts', {
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
});

type Post = typeof posts.$row;

const idAt = (suffix: string): string => `00000000-0000-7000-8000-${suffix.padStart(12, '0')}`;

const ORG = idAt('a1');
const OTHER_ORG = idAt('a2');
const MINE = idAt('11');
const THEIRS = idAt('22');

const post = (over: Partial<Post> = {}): Post => ({
  id: MINE,
  orgId: ORG,
  slug: 'ours',
  title: 'ours',
  ...over,
});

const SEED: readonly Post[] = [post(), post({ id: THEIRS, orgId: OTHER_ORG, slug: 'theirs' })];

let client: RecordingClient;

/** Every write path answers with the row it wrote, so `returning *` has something to decode. */
const stub = (): void => {
  client.on('write_parity_posts', {
    rows: [{ id: MINE, org_id: ORG, slug: 'ours', title: 'ours' }],
  });
};

beforeEach(() => {
  client = createRecordingClient();
  setDbClient(client);
  stub();
});

afterAll(() => {
  setDbClient(undefined);
  clearRegistry();
});

const pg = () => postgresRepo(posts);
const memory = (seed: readonly Post[] = SEED) => memoryRepo(posts, seed);

const asOrgA = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(createContext({ actor: userActor({ id: idAt('90'), orgId: ORG }) }), work);

/** The one shape allowed to write across tenants, and it says so out loud. */
const asReconciler = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(
    createContext({
      actor: serviceActor({ id: idAt('91'), orgId: ORG, scopes: [CROSS_TENANT_SCOPE] }),
    }),
    () => crossTenant('nightly reconciliation writes into every org', work),
  );

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : `threw ${String(error)}`;
  }
};

/**
 * One scenario, both drivers, and what each one must show for "nothing happened": no row in the
 * map, no statement on the wire. Returning the two codes together is what makes a divergence a
 * failed assertion rather than two tests that drift apart.
 */
const both = async (
  run: (repo: ReturnType<typeof pg> | ReturnType<typeof memory>) => Promise<unknown>,
): Promise<{
  pg: string;
  memory: string;
  statements: number;
  store: ReturnType<typeof memory>;
}> => {
  const store = memory();
  const inMemory = await codeOf(run(store));
  // `reset()` drops the registered stubs with the statements, so the second half re-registers.
  client.reset();
  stub();
  const inPostgres = await codeOf(run(pg()));
  return { pg: inPostgres, memory: inMemory, statements: client.statements.length, store };
};

/**
 * What the in-memory table actually holds for a tenant, counted OUTSIDE every request — the
 * no-context branch, where a caller names the tenant it means. Inside the request under test the
 * same read would be the guard's own answer rather than the table's.
 */
const rowsIn = async (store: ReturnType<typeof memory>, orgId: string): Promise<number> =>
  (await store.findMany({ orgId })).rows.length;

describe('a row may name the acting actor’s tenant, or none', () => {
  test('an insert into another tenant is refused by both, and neither writes it', async () => {
    const outcome = await asOrgA(() =>
      both((repo) => repo.insert(post({ id: idAt('33'), orgId: OTHER_ORG, slug: 'stolen' }))),
    );
    expect(outcome.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    // The refusal precedes the statement and the store: a guard that ran after the write would
    // leave the row behind and tell the caller it failed.
    expect(outcome.statements).toBe(0);
    // The seeded row of the other tenant, and nothing beside it.
    expect(await rowsIn(outcome.store, OTHER_ORG)).toBe(1);
  });

  test('one bad row refuses the whole batch, in both, before any of it lands', async () => {
    const outcome = await asOrgA(() =>
      both((repo) =>
        repo.insertAll([
          post({ id: idAt('34'), slug: 'a' }),
          post({ id: idAt('35'), orgId: OTHER_ORG, slug: 'b' }),
        ]),
      ),
    );
    expect(outcome.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.statements).toBe(0);
    // All or nothing, in memory too: the good row before it must not be stored, or one call means
    // two different things depending on which driver ran it.
    expect(await rowsIn(outcome.store, ORG)).toBe(1);
  });

  test('an upsert naming another tenant is refused even where it would have been skipped', async () => {
    // `onMatch: 'nothing'` writes nothing to a row it collides with, so the row never reaches the
    // store — checking only what lands would let this one through whenever it happened to collide.
    const outcome = await asOrgA(() =>
      both((repo) =>
        repo.upsertAll([post({ id: idAt('36'), orgId: OTHER_ORG, slug: 'theirs' })], {
          onConflict: ['slug'],
          onMatch: 'nothing',
        }),
      ),
    );
    expect(outcome.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.statements).toBe(0);
  });

  test('a patch that hands a row to another tenant is refused by both', async () => {
    const byId = await asOrgA(() => both((repo) => repo.update(MINE, { orgId: OTHER_ORG })));
    expect(byId.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(byId.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(byId.statements).toBe(0);

    const filtered = await asOrgA(() =>
      both((repo) => repo.updateWhere({ slug: 'ours' }, { orgId: OTHER_ORG })),
    );
    expect(filtered.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(filtered.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(filtered.statements).toBe(0);
  });

  // The PATCH is judged, never the rows it happened to reach: `postgresRepo` calls
  // `assertRowTenant` on it before the statement exists, so a filter matching nothing still
  // refuses. `memoryRepo` judged the merged rows inside its loop, and a loop over no rows judges
  // nothing — so the same call answered `0` there and threw here, and the guard's verdict depended
  // on the table's contents rather than on what the caller asked for.
  test('the patch is refused even when the filter matches no row at all', async () => {
    const outcome = await asOrgA(() =>
      both((repo) => repo.updateWhere({ slug: 'no-such-slug' }, { orgId: OTHER_ORG })),
    );
    expect(outcome.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(outcome.statements).toBe(0);
  });

  test('naming the actor’s own tenant is a restatement, and both write it', async () => {
    const outcome = await asOrgA(() =>
      both((repo) => repo.insert(post({ id: idAt('37'), orgId: ORG, slug: 'fresh' }))),
    );
    expect(outcome.memory).toBe('resolved');
    expect(outcome.pg).toBe('resolved');
    expect(outcome.statements).toBe(1);
  });

  test('a row that names no tenant is left alone, never filled in from the actor', async () => {
    // Refuse, do not stamp: the column's own NOT NULL is what answers a row missing its tenant,
    // and a stamped column would change which columns an upsert statement writes.
    const outcome = await asOrgA(() =>
      both((repo) => repo.update(MINE, { title: 'renamed' } as Partial<Post>)),
    );
    expect(outcome.memory).toBe('resolved');
    expect(outcome.pg).toBe('resolved');
  });

  test('an actor with no tenant of its own writes nothing tenant-scoped, in either driver', async () => {
    const outcome = await runWithContext(createContext(), () =>
      both((repo) => repo.insert(post({ id: idAt('38'), slug: 'anon' }))),
    );
    expect(outcome.memory).toBe('X_TENANCY_ACTOR_ORG_REQUIRED');
    expect(outcome.pg).toBe('X_TENANCY_ACTOR_ORG_REQUIRED');
    expect(outcome.statements).toBe(0);
  });

  test('outside every request the caller’s tenant stands, in both — a seed writes what it names', async () => {
    const outcome = await both((repo) =>
      repo.insert(post({ id: idAt('39'), orgId: OTHER_ORG, slug: 'seeded' })),
    );
    expect(outcome.memory).toBe('resolved');
    expect(outcome.pg).toBe('resolved');
    expect(outcome.statements).toBe(1);
  });

  test('crossTenant is the one way through, and it works in both', async () => {
    const outcome = await asReconciler(() =>
      both((repo) => repo.insert(post({ id: idAt('40'), orgId: OTHER_ORG, slug: 'swept' }))),
    );
    expect(outcome.memory).toBe('resolved');
    expect(outcome.pg).toBe('resolved');
    expect(outcome.statements).toBe(1);
  });
});

describe('the upsert collision cannot land on another tenant', () => {
  test('a target without the tenant column is refused under onMatch: update', async () => {
    // The stored half of the hazard, and the older of the two guards: the conflict target decides
    // WHICH row a collision lands on, so a target that omits the tenant column matches a row this
    // actor does not own — whatever tenant the incoming row names.
    const outcome = await asOrgA(() =>
      both((repo) =>
        repo.upsertAll([post({ id: idAt('41'), slug: 'ours' })], { onConflict: ['slug'] }),
      ),
    );
    expect(outcome.memory).toBe('X_TENANCY_UNSCOPED');
    expect(outcome.pg).toBe('X_TENANCY_UNSCOPED');
  });

  test('with the tenant in the target and the row, the pair leaves nothing to reach', async () => {
    // The incoming half is the new guard: every row must name the actor's tenant. Together the two
    // make a cross-tenant overwrite unrepresentable rather than documented — the target contains
    // the tenant column, so the key includes a value that can only be this actor's.
    const outcome = await asOrgA(() =>
      both((repo) =>
        repo.upsertAll([post({ id: MINE, orgId: ORG, slug: 'ours', title: 'renamed' })], {
          onConflict: ['orgId', 'slug'],
        }),
      ),
    );
    expect(outcome.memory).toBe('resolved');
    expect(outcome.pg).toBe('resolved');

    const stolen = await asOrgA(() =>
      both((repo) =>
        repo.upsertAll([post({ id: THEIRS, orgId: OTHER_ORG, slug: 'theirs', title: 'taken' })], {
          onConflict: ['orgId', 'slug'],
        }),
      ),
    );
    expect(stolen.memory).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(stolen.pg).toBe('X_TENANCY_ACTOR_MISMATCH');
    expect(stolen.statements).toBe(0);
  });
});
