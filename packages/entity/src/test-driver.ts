// The driver a scaffolded handle takes under test: memory until `setDbClient` installs a client,
// Postgres through that client while it is. Decided per call, because `database()` resolves each
// table's repository once, at module load, long before a test file installs its migrated database.

import { asyncContext } from '@ultimat3/core';
import { dbClientInstalled } from '@ultimat3/db';
import { type Driver, memoryDriver } from './database';
import type { EntityCore } from './entity';
import { testDriverClientChanged } from './errors';
import { postgresDriver } from './pg-driver';
import type { Repo, Transactor } from './repo';

type Side = 'memory' | 'postgres';

/**
 * The side an open `transactor().run` began on. Inside it a repository call takes that side, and a
 * client installed or cleared meanwhile is refused: following it would split one transaction's
 * writes across two stores, the one committed or rolled back without the other.
 */
const began = asyncContext<Side>('a testDriver() transaction');

const installedSide = (): Side => (dbClientInstalled() ? 'postgres' : 'memory');

const sideFor = (entityName: string): Side => {
  const now = installedSide();
  const open = began.get();
  if (open !== undefined && open !== now) throw testDriverClientChanged(entityName, open);
  return now;
};

/**
 * One repository per entity whose every method asks `pick()` at call time. A plain object of
 * forwarders rather than a `Proxy`: `observedRepo` spreads the repository, and a spread copies the
 * values a `Proxy` answers at that moment — the target would be frozen at module load. Keyed off
 * both repositories, so a method `Repo` gains later forwards with no edit here; `reset` is memory's
 * alone and stays on the driver.
 */
const following = <Row>(name: string, memory: Repo<Row>, postgres: Repo<Row>): Repo<Row> => {
  const pick = (): Repo<Row> => (sideFor(name) === 'postgres' ? postgres : memory);
  const forwarded: Record<string, unknown> = {};
  for (const key of Object.keys(postgres)) {
    if (typeof Reflect.get(memory, key) !== 'function') continue;
    forwarded[key] = (...args: unknown[]): unknown => {
      let target: Repo<Row>;
      try {
        target = pick();
      } catch (refusal) {
        // A repository call rejects, never throws synchronously — every `Repo` method is async.
        return Promise.reject(refusal);
      }
      const method: unknown = Reflect.get(target, key);
      // Both sides carried a function under this key when the forwarder was built.
      return (method as (...a: unknown[]) => unknown).apply(target, args);
    };
  }
  // Built from the keys both repositories carry, each forwarding to the same-named method.
  return forwarded as unknown as Repo<Row>;
};

/**
 * `storeMode(env) === 'memory' ? testDriver() : postgresDriver()` — the scaffolded handle's line.
 * A test file that never installs a client is exactly the memory driver: no PGlite is loaded, no
 * statement is sent. One that follows `wiki/Testing.md`'s recipe (`setDbClient(migrated.client)`,
 * then `setDbClient(undefined)` in `afterAll`) reads and writes its migrated database through the
 * same `db` the code under test imports — joins and raw SQL included.
 */
export const testDriver = (): Driver => {
  const memory = memoryDriver();
  const postgres = postgresDriver();
  const repos = new Map<string, unknown>();
  return {
    repo<Row>(entity: EntityCore<Row>): Repo<Row> {
      const existing = repos.get(entity.$name);
      // Keyed by entity name and only written from that entity, as `memoryDriver` keys its own.
      if (existing !== undefined) return existing as Repo<Row>;
      const created = following(entity.$name, memory.repo(entity), postgres.repo(entity));
      repos.set(entity.$name, created);
      return created;
    },
    // Memory only: the installed database's rows are the test's own, emptied by its own template.
    reset: () => memory.reset?.(),
    transactor: (): Transactor => ({
      run: (work) => {
        const side = installedSide();
        const target = side === 'postgres' ? postgres : memory;
        return began.run(side, () => target.transactor().run(work));
      },
    }),
  };
};
