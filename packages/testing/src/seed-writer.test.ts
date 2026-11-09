// `entitySeedWriter` against the in-memory driver: a seed graph writes through each entity's own
// repository, a deferred cycle key lands by `updateWhere`, the tenant rides as the repository's
// `orgId`, and a plan naming an entity the writer was not handed is refused by code.

import { describe, expect, test } from 'bun:test';
import {
  type AnyColumn,
  type Driver,
  type EntityCore,
  entity,
  memoryDriver,
  type Repo,
  text,
  uuid,
} from '@ultimat3/entity';
import { seedGraph } from './seed-graph';
import { entitiesOf, TRACKED_APPS } from './seed-graph-apps-fixture';
import { insertSeedGraph } from './seed-graph-plan';
import { digestRow, entitySeedWriter } from './seed-writer';
import { testName } from './test-types';

const orgs = entity('sw_orgs', { columns: { id: uuid().primaryKey() } });
const teams = entity('sw_teams', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    name: text({ max: 40 }),
    captainId: uuid()
      .references((): AnyColumn => players.id)
      .nullable(),
  },
});
const players = entity('sw_players', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id)
      .tenant(),
    teamId: uuid().references((): AnyColumn => teams.id),
  },
});
const schema = { orgs, teams, players };

/** Every row of a tenant-scoped table, tenant by tenant: a memory read needs its `orgId`. */
const rowsIn = async (
  driver: Driver,
  target: EntityCore,
  tenants: readonly string[],
): Promise<Record<string, unknown>[]> => {
  const repo = driver.repo(target) as Repo<Record<string, unknown>>;
  const scopes = target.$tenantColumn === null ? [undefined] : tenants;
  const pages = await Promise.all(
    scopes.map((orgId) => repo.findMany({ limit: 100, ...(orgId === undefined ? {} : { orgId }) })),
  );
  return pages.flatMap((page) => [...page.rows]);
};

describe(testName('unit', 'entitySeedWriter'), () => {
  test('every row lands through the driver, and a cycle key is set by the update', async () => {
    const driver = memoryDriver();
    const graph = seedGraph(schema, { tenants: 2, perTable: 2, seed: 3 });
    expect(graph.updates.length).toBeGreaterThan(0);
    await insertSeedGraph(graph, entitySeedWriter({ entities: schema, driver }));

    for (const target of Object.values(schema)) {
      const stored = await rowsIn(driver, target, graph.tenants);
      expect({ name: target.$name, n: stored.length }).toEqual({
        name: target.$name,
        n: graph.inserts.filter((row) => row.entity === target.$name).length,
      });
    }
    const captains = (await rowsIn(driver, teams, graph.tenants)).map((row) => row['captainId']);
    expect(captains.sort()).toEqual(graph.updates.map((u) => u.patch['captainId']).sort());
  });

  test('a tenant-scoped write carries its tenant as orgId; a tenantless one carries none', async () => {
    const seen: { entity: string; op: string; orgId: unknown }[] = [];
    const inner = memoryDriver();
    const driver: Driver = {
      ...inner,
      repo<Row>(target: EntityCore<Row>): Repo<Row> {
        const repo = inner.repo(target);
        return {
          ...repo,
          insert: (values, options) => {
            seen.push({ entity: target.$name, op: 'insert', orgId: options?.orgId });
            return repo.insert(values, options);
          },
          // A graph's rows of one table are one write: the scope rides when every row shares it.
          insertAll: (values, options) => {
            seen.push({ entity: target.$name, op: 'insert', orgId: options?.orgId });
            return repo.insertAll(values, options);
          },
          updateWhere: (filter, patch, options) => {
            seen.push({ entity: target.$name, op: 'update', orgId: options?.orgId });
            return repo.updateWhere(filter, patch, options);
          },
        };
      },
    };
    const graph = seedGraph(schema, { tenants: 1, perTable: 1 });
    await insertSeedGraph(graph, entitySeedWriter({ entities: schema, driver }));
    const tenant = graph.tenants[0];
    expect(seen).toEqual([
      { entity: 'sw_orgs', op: 'insert', orgId: undefined },
      { entity: 'sw_teams', op: 'insert', orgId: tenant },
      { entity: 'sw_players', op: 'insert', orgId: tenant },
      { entity: 'sw_teams', op: 'update', orgId: tenant },
    ]);

    seen.length = 0;
    const writer = entitySeedWriter({ entities: schema, driver, tenantOf: () => 'pinned' });
    const id = '00000000-0000-7000-8000-00000000000f';
    await writer.insert({ entity: 'sw_orgs', table: 'sw_orgs', tenant: null, row: { id } });
    expect(seen).toEqual([{ entity: 'sw_orgs', op: 'insert', orgId: 'pinned' }]);
  });

  test('a snapshot digests each row: equal unchanged, new after a write, null once gone', async () => {
    const driver = memoryDriver();
    const writer = entitySeedWriter({ entities: schema, driver });
    const graph = seedGraph(schema, { tenants: 2, perTable: 2, seed: 5 });
    await insertSeedGraph(graph, writer);
    const [one, other] = graph.tenants as [string, string];
    const mine = graph.inserts.filter((row) => row.tenant === one && row.entity !== 'sw_orgs');
    const before = await writer.snapshot(mine);
    expect(before.every((digest) => typeof digest === 'string')).toBe(true);
    expect(new Set(before).size).toBe(before.length);
    expect(await writer.snapshot(mine)).toEqual(before);

    const [team, player] = [
      mine.find((row) => row.entity === 'sw_teams'),
      mine.find((row) => row.entity === 'sw_players'),
    ];
    const repoOf = (target: EntityCore) => driver.repo(target) as Repo<Record<string, unknown>>;
    await repoOf(teams).update(String(team?.row['id']), { name: 'renamed' }, { orgId: one });
    await repoOf(players).delete(String(player?.row['id']), { orgId: one });
    const after = await writer.snapshot(mine);
    const changed = mine.flatMap((row, i) => (after[i] === before[i] ? [] : [row.row['id']]));
    expect(changed.sort()).toEqual([team?.row['id'], player?.row['id']].sort());
    expect(after[mine.indexOf(player as (typeof mine)[number])]).toBeNull();
    // The other tenant's rows are read under their own tenant, untouched.
    const theirs = graph.inserts.filter((row) => row.tenant === other && row.entity !== 'sw_orgs');
    expect((await writer.snapshot(theirs)).every((digest) => digest !== null)).toBe(true);
  });

  test('a row digest is injective: bytes, their hex text, a date and its ISO text differ', () => {
    const at = new Date('2026-11-09T10:00:00.000Z');
    expect(digestRow({ v: new Uint8Array([0xab]) })).not.toBe(digestRow({ v: 'ab' }));
    expect(digestRow({ v: at })).not.toBe(digestRow({ v: at.toISOString() }));
    expect(digestRow({ v: 5n })).not.toBe(digestRow({ v: '5' }));
    // Key order is not part of a row.
    expect(digestRow({ a: 1, b: 2 })).toBe(digestRow({ b: 2, a: 1 }));
  });

  test('an entity the writer was not handed is refused, naming the set it was', async () => {
    const writer = entitySeedWriter({ entities: { orgs }, driver: memoryDriver() });
    let caught: unknown;
    try {
      await writer.insert({ entity: 'sw_nope', table: 'sw_nope', tenant: null, row: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUltimateError('X_SEED_GRAPH_ENTITY_UNKNOWN');
    expect(caught).toMatchObject({ cause: expect.stringContaining('sw_orgs') });
  });
});

describe(testName('unit', 'entitySeedWriter over both tracked apps, in memory'), () => {
  for (const app of TRACKED_APPS) {
    test(`${app.name}: every generated row inserts into the memory driver`, async () => {
      const entities = await entitiesOf(app.root);
      const driver = memoryDriver();
      const graph = seedGraph(entities, { tenants: 2, perTable: 3, seed: 11 });
      await insertSeedGraph(graph, entitySeedWriter({ entities, driver }));
      for (const target of Object.values(entities)) {
        const stored = await rowsIn(driver, target, graph.tenants);
        const expected = graph.inserts.filter((row) => row.entity === target.$name).length;
        expect({ name: target.$name, n: stored.length }).toEqual({
          name: target.$name,
          n: expected,
        });
      }
    });
  }
});
