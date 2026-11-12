// One chunk's sends at a bounded width that NEVER answers over a send in flight: on the run's
// abort (a drain) nothing new is claimed, and every claimed send settles its ledger row before the
// step answers. `mapBounded` rejects at once, which left rows `sending` behind an exiting process.

/**
 * `run` over `items`, `width` at a time, in input order. An item `run` never started (the signal
 * aborted first) has no outcome; the caller asks `signal.aborted` and fails the step for its retry.
 * `run` must not throw: each recipient's failure is its own outcome.
 */
export async function settledPool<T, R>(
  items: readonly T[],
  width: number,
  signal: AbortSignal,
  run: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<readonly R[]> {
  const outcomes: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    // Checked before each claim: an abort stops the pulling, never a send already started.
    for (let index = next++; index < items.length && !signal.aborted; index = next++) {
      outcomes[index] = await run(items[index] as T, signal);
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(width, items.length) }, worker));
  return outcomes;
}
