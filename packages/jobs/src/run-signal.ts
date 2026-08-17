// The signal ONE job run is cancelled by: the caller's `Ctx.signal`, the lease heartbeat, and
// whatever else the worker holds over the run. `AbortSignal.any` composed the same thing and could
// not be undone — an app wiring a process-lifetime controller into `WorkerOptions.context()` grew
// one composite per job for the life of the worker, and nothing could abort the result either.

export interface RunSignal {
  /** Handed to the run as `ctx.signal`; dies with the run. */
  readonly signal: AbortSignal;
  /** Cancel this run. The first reason wins, exactly as `AbortController.abort` already does. */
  abort(reason: unknown): void;
  /**
   * Stop following the sources. Idempotent, and it never aborts: a run that settled leaves its
   * signal in whatever state it ended in, it just stops being the caller's problem.
   */
  dispose(): void;
}

/**
 * One controller per run, following every source it was given. A source already aborted aborts the
 * run at composition, carrying its own reason — the same semantics `AbortSignal.any` has, minus
 * the part that cannot be handed back.
 *
 * `undefined` and a non-`AbortSignal` are both skipped rather than refused: `Ctx.signal` is
 * non-optional in the type and still arrives missing across a cast (`@ultimat3/http`'s `asCtx`, a
 * test's `{} as Ctx`), and a job that crashed on a missing field is worse than a job with no
 * caller to follow.
 */
export function createRunSignal(sources: readonly (AbortSignal | undefined)[]): RunSignal {
  const controller = new AbortController();
  const detach: (() => void)[] = [];

  for (const source of sources) {
    if (!(source instanceof AbortSignal)) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      continue;
    }
    const forward = (): void => controller.abort(source.reason);
    source.addEventListener('abort', forward, { once: true });
    detach.push(() => source.removeEventListener('abort', forward));
  }

  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      for (const off of detach.splice(0)) off();
    },
  };
}
