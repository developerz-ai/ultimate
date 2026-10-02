// One declared island STATE, mounted: the lookup every island test hand-rolled, and the suite
// form that owns the `beforeAll` / `afterAll` a mount needs because it installs a process-global
// `document`. The props a test asserts on are the props `x shot --island` photographs, so the
// picture and the test cannot be of two different components.

import { afterAll, beforeAll, describe } from 'bun:test';
import { assert } from '@ultimat3/core';
import type {
  IslandBuilder,
  IslandBundleLike,
  MountedIsland,
  MountIslandOptions,
} from './fixture-island';
import { mountIsland } from './fixture-island';
import { IslandStateUnknownError } from './island-state-errors';
import type { IslandStatesManifest } from './island-states';
import type { TestOptions } from './test-types';
import { testName } from './test-types';

/** What a state's mount takes: `mountIsland`'s options, minus what the manifest already says. */
export type IslandStateMountOptions = Omit<MountIslandOptions, 'file' | 'props'>;

/** The suite form's: the mount's own, plus the deadline of the `beforeAll` that runs it. */
export interface IslandStateSuiteOptions extends IslandStateMountOptions, TestOptions {}

/**
 * The deadline a block's mount gets when it names none. The first mount in a file pays the island
 * build — a Babel pass and a browser bundle, seconds not milliseconds — and Bun's 5 s default is
 * what a cold CI runner misses.
 */
export const ISLAND_MOUNT_TIMEOUT_MS = 60_000;

/**
 * Bundles already built in this process, per builder, by `<root>\0<island>`. A file with three
 * states used to build its island three times; the source cannot change between two mounts of one
 * test run, so the second is a lookup. A build that REJECTS is forgotten, so the next mount
 * reports its own failure rather than a cached one.
 */
const bundles = new WeakMap<IslandBuilder, Map<string, Promise<IslandBundleLike>>>();

const buildOnce =
  (build: IslandBuilder): IslandBuilder =>
  (root, options) => {
    const built = bundles.get(build) ?? new Map<string, Promise<IslandBundleLike>>();
    bundles.set(build, built);
    const key = `${root}\0${options?.only ?? ''}`;
    const known = built.get(key);
    if (known !== undefined) return known;
    const pending = build(root, options);
    built.set(key, pending);
    pending.catch(() => built.delete(key));
    return pending;
  };

/**
 * Mount one state the manifest declares. `using island = await mountIslandState(states, 'idle',
 * { build: buildIslands, root })` inside one test — `using` owns the teardown. A file asserting
 * several things about one state uses `describeIslandState`, which owns it for the block.
 */
export async function mountIslandState(
  manifest: IslandStatesManifest,
  id: string,
  options: IslandStateMountOptions,
): Promise<MountedIsland> {
  const state = manifest.states.find((one) => one.id === id);
  if (state === undefined) {
    throw new IslandStateUnknownError({
      island: manifest.island,
      id,
      known: manifest.states.map((one) => one.id),
    });
  }
  return mountIsland({
    ...options,
    build: buildOnce(options.build),
    file: manifest.island,
    props: state.props,
  });
}

/**
 * One block per declared state: mounted before its first test, disposed after its last, with the
 * island built once per file. `body` is handed an ACCESSOR, for `describeApp`'s reason — the
 * block is declared at module scope and the mount does not exist until `beforeAll` has run:
 *
 * ```ts
 * describeIslandState(counterStates, 'idle', { build: buildIslands, root }, (island) => {
 *   test('a click reaches the DOM', () => {
 *     expect(island().fire('button', 'click')).toBe(true);
 *   });
 * });
 * ```
 *
 * Calls `describe`, so it goes at declaration scope. The block is named for the `unit` step — an
 * island test is `<name>.island.test.ts`, which that step owns.
 */
export function describeIslandState(
  manifest: IslandStatesManifest,
  id: string,
  options: IslandStateSuiteOptions,
  body: (island: () => MountedIsland) => void,
): void {
  const { timeoutMs, ...mount } = options;
  describe(testName('unit', `the ${manifest.name} island, ${id}`), () => {
    let mounted: MountedIsland | undefined;
    let over = false;
    beforeAll(async () => {
      const island = await mountIslandState(manifest, id, mount);
      // A mount that outlived its deadline lands after `afterAll` has already run: disposed here,
      // or its fake `document` is every later block's.
      if (over) island[Symbol.dispose]();
      else mounted = island;
    }, timeoutMs ?? ISLAND_MOUNT_TIMEOUT_MS);
    // Bun runs `afterAll` whether or not the mount resolved, so this reads what is there.
    afterAll(() => {
      over = true;
      mounted?.[Symbol.dispose]();
      mounted = undefined;
    });
    body(() => {
      assert(
        mounted !== undefined,
        `the ${manifest.name} island's "${id}" state is not mounted — its mount failed, or the accessor was called outside this block's tests`,
        'call the accessor inside a test of this describeIslandState block; a failed mount is reported above this line, by its own error',
      );
      return mounted;
    });
  });
}
