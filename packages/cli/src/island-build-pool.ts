// The pool the island build runs its groups through: at most `width` at once, answers in item
// order, and stopped by its first failure.

/**
 * `run` over `items`, at most `width` at a time, answers in `items` order. 159 builds at once (the
 * bench app) bought nothing over twelve — the plugins' callbacks share one JS thread — and held
 * every build's graph in memory together.
 */
export async function boundedMap<T, R>(
  items: readonly T[],
  width: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // Set by the first rejection and read before every start: the builds already in flight finish
  // (a `Bun.build` cannot be cancelled), but no idle worker takes another group — in `x dev` one
  // island's syntax error left every remaining group bundling, ~12 s, into the next generation.
  // And the call answers only once those in flight HAVE finished: each registers stylesheets and
  // pins chunk bytes process-wide, so one outliving the call would write into the next generation.
  let failure: { readonly error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    for (let index = next++; failure === undefined && index < items.length; index = next++) {
      try {
        results[index] = await run(items[index] as T);
      } catch (error) {
        if (failure === undefined) failure = { error };
      }
    }
  };
  const workers = Math.max(1, Math.min(width, items.length));
  await Promise.all(Array.from({ length: items.length === 0 ? 0 : workers }, worker));
  if (failure !== undefined) throw failure.error;
  return results;
}
