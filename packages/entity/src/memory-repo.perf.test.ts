// The memory driver is the default dev and test driver, so its cost curve is a product property:
// `findById` filtered and sorted the whole table (6.49 ms at 20k rows), which made a test walking a
// table by id quadratic. Measured as a RATIO between two table sizes, never an absolute time, so a
// slow CI runner moves both sides alike and the test still fails only on a change of shape.
import { afterAll, expect, test } from 'bun:test';
import { integer, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

const items = entity('memory_perf_items', {
  columns: { id: uuid().primaryKey(), rank: integer() },
});

const idAt = (n: number): string => `00000000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

/** Milliseconds per `findById`, over a table of `size` rows, best of three rounds. */
const perLookup = async (size: number): Promise<number> => {
  const repo = memoryRepo(items);
  await repo.insertAll(Array.from({ length: size }, (_, n) => ({ id: idAt(n), rank: n })));
  const lookups = 200;
  let best = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 3; round += 1) {
    const started = performance.now();
    for (let n = 0; n < lookups; n += 1) {
      const found = await repo.findById(idAt((n * 97) % size));
      if (found === null) expect.unreachable('a stored row was not found');
    }
    best = Math.min(best, (performance.now() - started) / lookups);
  }
  return best;
};

test('findById does not grow with the table', async () => {
  const small = await perLookup(200);
  const large = await perLookup(20_000);
  // 100× the rows. A scan-and-sort is ~100× slower (and more); a keyed read stays within noise.
  expect(large / small).toBeLessThan(5);
}, 60_000);
