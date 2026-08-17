// Single responsibility: what a read-through fill is allowed to PUBLISH. `cache.test.ts` proves
// how many times the read path reaches for the tier; this proves whether the answer it got is
// still true by the time it would be written down.
//
// T0 miss → `run()`. T1 a mutator commits and `invalidateTags` drops a key that is not there yet,
// so the drop is a no-op and the report says `errors: []`. T2 `run()` resolves with pre-write rows.
// T3 the fill publishes them for the full TTL — invisible to every reader until it expires. The
// fence is `@ultimat3/cache`'s, sampled before the load and asked before the write; there is no
// second one here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { declareTags, invalidateTags, isolateDeclaredTags, tag } from '@ultimat3/cache';
import { createContext } from '@ultimat3/core';
import { readThrough } from './cache';
import { getReadCache, MemoryReadCache, setReadCache } from './read-cache';

/** A source that hangs until released, so the sequence below is an ordering, not a duration. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const original = getReadCache();
const restoreTags = isolateDeclaredTags();
declareTags(['post', 'comment']);

beforeEach(() => {
  setReadCache(new MemoryReadCache());
});

afterAll(() => {
  setReadCache(original);
  restoreTags();
});

/**
 * "Was it published?" is asked of the tier itself rather than of a call counter: what matters is
 * whether a later reader can be served the entry, and a count of `set` calls is one step removed
 * from that.
 */
const published = async (key: string): Promise<unknown> => (await getReadCache().get(key))?.value;

describe('the fence around a read-through fill', () => {
  /**
   * T0: the source read has STARTED — `entered` resolves from inside it. Sampling the fence before
   * the load is the whole mechanism, and a bust landing before the read began is a bust the read
   * will see for itself.
   */
  function startedRead(value: string): {
    readonly run: () => Promise<string>;
    readonly entered: Promise<void>;
    readonly finish: () => void;
    readonly calls: () => number;
  } {
    const source = gate();
    const entry = gate();
    let calls = 0;
    return {
      entered: entry.wait,
      finish: source.open,
      calls: () => calls,
      run: async () => {
        calls += 1;
        entry.open();
        await source.wait;
        return value;
      },
    };
  }

  test('a bust that lands mid-read is answered, never published', async () => {
    const read = startedRead('pre-write rows');

    const reading = readThrough(createContext({}), 'k', 60_000, read.run, [tag('post')]);
    await read.entered;
    // The drop finds no key — it is not in the tier yet — so it reports `errors: []`.
    await invalidateTags([tag('post')]);
    read.finish();

    // Its own caller still gets what the source read: that IS this request's answer, and
    // swallowing it would turn a cache concern into a failed business read.
    expect(await reading).toBe('pre-write rows');
    expect(read.calls()).toBe(1);
    // Nobody else does. Published, this would have been served for the whole 60s.
    expect(await published('k')).toBeUndefined();
  });

  test('the next request re-reads, rather than joining an entry that was never written', async () => {
    const first = startedRead('pre-write rows');

    const reading = readThrough(createContext({}), 'k', 60_000, first.run, [tag('post')]);
    await first.entered;
    await invalidateTags([tag('post')]);
    first.finish();
    await reading;

    const second = await readThrough(
      createContext({}),
      'k',
      60_000,
      async () => 'post-write rows',
      [tag('post')],
    );
    expect(second).toBe('post-write rows');
  });

  test('a bust of an unrelated tag does not stop the write', async () => {
    const read = startedRead('rows');

    const reading = readThrough(createContext({}), 'k', 60_000, read.run, [tag('comment')]);
    await read.entered;
    await invalidateTags([tag('post')]);
    read.finish();
    await reading;

    expect(await published('k')).toBe('rows');
  });

  test('a fill nothing raced still writes', async () => {
    await readThrough(createContext({}), 'k', 60_000, async () => 'rows', [tag('post')]);

    expect(await published('k')).toBe('rows');
  });
});
