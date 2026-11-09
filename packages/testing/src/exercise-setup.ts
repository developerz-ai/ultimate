// `defineExercise(…, { setup })`, run: the app's hook inside the pass's sealed room, before the
// first row is seeded, disposed before the room restores the network. What it installs — a
// `mockFetch` route, a `cassette()` — answers a vendor call; `allowHost` would send one for real.
// Several hooks (one per feature group) run in order and are undone in reverse.

import { renderCauseValue, UltimateError } from '@ultimat3/core';
import type { ExerciseRoom } from './exercise-report';
import { captureNetwork } from './sealed-network';

/** What a setup may hand back to be undone after the pass: a `cassette()`, a `using` resource. */
export type ExerciseSetupHandle = Disposable | AsyncDisposable;

/**
 * Runs once per pass, in the exercise process, after the seal and before any primitive. Returns
 * nothing when there is nothing to undo — a `mockFetch` route goes with the room.
 */
export type ExerciseSetup = () =>
  | void
  | ExerciseSetupHandle
  | Promise<void>
  | Promise<ExerciseSetupHandle>
  | Promise<ExerciseSetupHandle | undefined>;

const setupUnsealed = (hosts: readonly string[]): UltimateError =>
  new UltimateError({
    code: 'X_EXERCISE_SETUP_UNSEALED',
    cause: `defineExercise(…, { setup }) called allowHost(${hosts.map((host) => renderCauseValue(host)).join(', ')}): the pass would send a primitive's call out for real, where every vendor is answered by mockFetch or cassette()`,
    fix: "mockFetch('https://<host>/*', handler)   # or cassette(import.meta.dir, '<name>') — in apps/web/exercise.ts's setup, in place of allowHost('<host>')",
    meta: { hosts },
  });

async function release(handle: unknown): Promise<void> {
  if (typeof handle !== 'object' || handle === null) return;
  if (Symbol.asyncDispose in handle) await (handle as AsyncDisposable)[Symbol.asyncDispose]();
  else if (Symbol.dispose in handle) (handle as Disposable)[Symbol.dispose]();
}

/**
 * Every handle released, last first, and then the room — each whatever the one before it threw;
 * the first throw is what the caller sees, once nothing is left installed.
 */
async function releaseAll(handles: readonly unknown[], room: ExerciseRoom): Promise<void> {
  let failed = false;
  let first: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await release(handle);
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  await room[Symbol.asyncDispose]();
  if (failed) throw first;
}

/**
 * `room` with each setup run inside it, in order. Its dispose releases what they returned FIRST,
 * in reverse — a cassette's own check reads the routes the pass used — then the room. A setup that
 * throws disposes those that already ran and the room; one that lets a host through, all of them.
 */
export async function withExerciseSetup(
  room: ExerciseRoom,
  setup: ExerciseSetup | readonly ExerciseSetup[] | undefined,
): Promise<ExerciseRoom> {
  const setups = setup === undefined ? [] : typeof setup === 'function' ? [setup] : setup;
  if (setups.length === 0) return room;
  const before = new Set(captureNetwork().allowed);
  const handles: unknown[] = [];
  for (const one of setups) {
    try {
      handles.push(await one());
    } catch (error) {
      await releaseAll(handles, room);
      throw error;
    }
  }
  const dispose = (): Promise<void> => releaseAll(handles, room);
  const opened = captureNetwork().allowed.filter((host) => !before.has(host));
  if (opened.length > 0) {
    await dispose();
    throw setupUnsealed(opened);
  }
  return { ...room, [Symbol.asyncDispose]: dispose };
}
