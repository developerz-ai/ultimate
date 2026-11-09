// `factorySeed(name, body)`: a named seed whose rows come from factories — `defineSeed`'s own run
// (tier, dry run, metrics, `x db seed`), with every `create()` in the body written through the
// seed's idempotent insert. Every factory sequence restarts first, so a replay draws the same ids
// and writes nothing new. `@ultimat3/entity` loads on `run()`, never on import.

import type { Seed, SeedContext, SeedInit, SeedRun } from '@ultimat3/entity';
import { FactoryNotPersistedError } from './errors';
import { resetFactorySequences } from './factories';
import { isEntity, type Persister, swapPersister } from './factory-persist';

/**
 * A `create()` inside a seed: the seed's `insert` — `on conflict do nothing` by primary key, counted
 * in its metrics, rolled back by a dry run. It answers the row as WRITTEN (`$parse`d): a seed reads
 * nothing back, so a replay's skipped row answers what this run would have written.
 */
const seedPersister = (context: SeedContext): Persister => ({
  async insert(entity, row) {
    if (!isEntity(entity)) throw new FactoryNotPersistedError({ table: entity.$table });
    const parsed = entity.$parse(row) as object;
    await context.insert(entity, [parsed as Parameters<SeedContext['insert']>[1][number]]);
    return parsed;
  },
});

/**
 * `export const demo = factorySeed('demo', async ({ id }) => { await posts.create({ comments: 2,
 * org: await orgs.create({ id: id('org:acme') }) }) })` — then `x db seed demo`, or
 * `demo.run({ driver })` from a test. Same name, same rows, every run.
 */
export function factorySeed(
  name: string,
  build: (context: SeedContext) => Promise<void>,
  init: SeedInit = {},
): Seed {
  const tier = init.tier ?? 'dev';
  return {
    name,
    tier,
    run: async (options = {}): Promise<SeedRun> => {
      const { defineSeed } = await import('@ultimat3/entity');
      const seed = defineSeed(
        name,
        async (context) => {
          resetFactorySequences();
          const previous = swapPersister(seedPersister(context));
          try {
            await build(context);
          } finally {
            swapPersister(previous);
          }
        },
        { tier },
      );
      return seed.run(options);
    },
  };
}
