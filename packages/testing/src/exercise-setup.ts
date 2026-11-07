// `defineExercise(…, { setup })`, run: the app's hook inside the pass's sealed room, before the
// first row is seeded, disposed before the room restores the network. What it installs — a
// `mockFetch` route, a `cassette()` — answers a vendor call; `allowHost` would send one for real.

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
  | Promise<void | ExerciseSetupHandle | undefined>;

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
 * `room` with `setup` run inside it. Its dispose releases what setup returned FIRST — a cassette's
 * own check reads the routes the pass used — then the room. A setup that throws, or lets a host
 * through, disposes both before the pass refuses.
 */
export async function withExerciseSetup(
  room: ExerciseRoom,
  setup: ExerciseSetup | undefined,
): Promise<ExerciseRoom> {
  if (setup === undefined) return room;
  const before = new Set(captureNetwork().allowed);
  let handle: unknown;
  try {
    handle = await setup();
  } catch (error) {
    await room[Symbol.asyncDispose]();
    throw error;
  }
  const dispose = async (): Promise<void> => {
    try {
      await release(handle);
    } finally {
      await room[Symbol.asyncDispose]();
    }
  };
  const opened = captureNetwork().allowed.filter((host) => !before.has(host));
  if (opened.length > 0) {
    await dispose();
    throw setupUnsealed(opened);
  }
  return { ...room, [Symbol.asyncDispose]: dispose };
}
