// The `seed` fixture's machinery: `seed('demo')` runs that named seed (a `factorySeed` or any
// `defineSeed`) once per test into the driver the APP reads through, and `.pick({ ada: 'member:ada'
// })` hands back the rows it wrote, by the labels the seed gave them. An app registers it with its
// own seeds and driver — `defineFixtures({ seed: seedFixture({ seeds: [demo], driver }) })`.

import { assert } from '@ultimat3/core';
import type { Driver, EntityCore, Repo, Seed, SeedRun } from '@ultimat3/entity';

/** A row a seed wrote, as it handed it to the driver. */
export interface SeededRow {
  readonly id: string;
  readonly [column: string]: unknown;
}

/** One named seed, run for this test. */
export interface SeedHandle {
  /** What the run did — `inserted` 0 on a replay into a driver that already holds its rows. */
  readonly ran: Promise<SeedRun>;
  /** `pick({ draft: 'post:draft' })` — seed labels in, rows out, aliased at the call site. */
  pick<const M extends Readonly<Record<string, string>>>(
    labels: M,
  ): Promise<{ readonly [K in keyof M]: SeededRow }>;
}

export interface SeedFixtureOptions {
  /** Every seed a test may name, each under its own `name`. */
  readonly seeds: readonly Seed[];
  /**
   * The driver the app reads through — never one of the fixture's own: rows written where nothing
   * else looks are an empty table to every action under test.
   */
  readonly driver: () => Driver;
}

const idOf = (row: unknown): string | undefined => {
  const value = (row as { readonly id?: unknown } | null)?.id;
  return typeof value === 'string' ? value : undefined;
};

/**
 * Rows are captured on the way IN, not read back: a tenant-scoped entity refuses an unscoped read,
 * and a seed's `upsertAll(…, { onMatch: 'nothing' })` answers nothing for a row already stored — so
 * a replay still finds every label.
 */
function capturing(base: Driver, rows: Map<string, SeededRow>): Driver {
  const capture = (row: unknown): void => {
    const id = idOf(row);
    if (id !== undefined) rows.set(id, row as SeededRow);
  };
  return {
    transactor: () => base.transactor(),
    repo: <Row>(entity: EntityCore<Row>): Repo<Row> => {
      const inner = base.repo(entity);
      return {
        ...inner,
        insert: async (values, options) => {
          const row = await inner.insert(values, options);
          capture(row);
          return row;
        },
        upsertAll: async (batch, args) => {
          for (const row of batch) capture(row);
          return inner.upsertAll(batch, args);
        },
      };
    },
  };
}

/**
 * The fixture factory. Per test: each name runs at most once (a second `seed('demo')` is the same
 * handle), and a seed's own inserts are idempotent, so the next test's run writes nothing new.
 */
export function seedFixture(options: SeedFixtureOptions): () => (name: string) => SeedHandle {
  const byName = new Map(options.seeds.map((seed) => [seed.name, seed]));
  return () => {
    const handles = new Map<string, SeedHandle>();
    return (name) => {
      const seed = byName.get(name);
      assert(
        seed !== undefined,
        `no seed named "${name}" is registered with the seed fixture — known: ${[...byName.keys()].join(', ')}`,
        `add it to seedFixture({ seeds: [${name}, …], driver }) in the test preload, or name one of the known seeds`,
      );
      const open = handles.get(name);
      if (open !== undefined) return open;
      const rows = new Map<string, SeededRow>();
      const ran = seed.run({ driver: capturing(options.driver(), rows) });
      const handle: SeedHandle = {
        ran,
        pick: async (labels) => {
          await ran;
          const { seedId } = await import('@ultimat3/entity');
          const picked: Record<string, SeededRow> = {};
          for (const [alias, label] of Object.entries(labels)) {
            const row = rows.get(seedId(label));
            assert(
              row !== undefined,
              `seed "${name}" wrote no row labelled "${label}"`,
              `give the row id: id('${label}') in the seed "${name}" declares, or pick a label it writes`,
            );
            picked[alias] = row;
          }
          return picked as { readonly [K in keyof typeof labels]: SeededRow };
        },
      };
      handles.set(name, handle);
      return handle;
    };
  };
}
